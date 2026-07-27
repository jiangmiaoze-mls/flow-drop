import {mkdir, open} from 'node:fs/promises'
import type {FileHandle} from 'node:fs/promises'
import path from 'node:path'

import {V3TransportError} from './v3TransportError'
import {
  type V3ChunkMetadata,
  type V3ChunkPreflightResult,
  V3TransferStore
} from './v3TransferStore'
import type {V3ChunkAck} from './v3TransportTypes'

export const V3_TRANSFER_BATCH_SIZE = 4
export const V3_TRANSFER_BATCH_WINDOW_MS = 20

const MAX_QUEUED_CHUNKS_PER_TRANSFER = 16
const MAX_QUEUED_CHUNK_REQUESTS = 16
const MAX_QUEUED_CHUNK_REQUESTS_PER_TRANSFER = 8

export type V3TransferWriterChange = {
  revision: number
  transferId: string
}

export type V3TransferWriterOptions = {
  batchSize?: number
  batchWindowMs?: number
  maxQueuedChunksPerTransfer?: number
  maxQueuedChunkRequests?: number
  maxQueuedChunkRequestsPerTransfer?: number
  onCommitted?: (change: V3TransferWriterChange) => void
}

export type V3QueuedChunk = {
  chunkIndex: number
  data: Buffer
  itemId: string
  offset: number
  sha256: string
  sourceDeviceId: string
  transferId: string
}

/**
 * A completion callback may use this only before it has durably started
 * completion. The writer reopens the chunk queue and preserves the original
 * error as `cause` so the service can return it to the caller.
 */
export class V3TransferCompletionRetryableError extends Error {
  constructor(public readonly cause: Error) {
    super(cause.message)
    this.name = 'V3TransferCompletionRetryableError'
  }
}

type QueueJob = V3QueuedChunk & {
  enqueuedAt: number
  id: number
  key: string
  promise: Promise<V3ChunkAck>
  reject: (reason: Error) => void
  resolve: (ack: V3ChunkAck) => void
  waiterCount: number
}

export class V3TransferWriter {
  private accepting = true
  private readonly batchSize: number
  private readonly batchWindowMs: number
  private closed = false
  private readonly maxQueuedChunksPerTransfer: number
  private readonly maxQueuedChunkRequests: number
  private readonly maxQueuedChunkRequestsPerTransfer: number
  private nextJobId = 1
  private queuedChunkRequests = 0
  private readonly runningCompletions = new Map<string, Promise<unknown>>()
  private readonly queues = new Map<string, TransferWriteQueue>()
  private readonly transferOperationTails = new Map<string, Promise<void>>()

  constructor(
    private readonly transferStore: V3TransferStore,
    private readonly options: V3TransferWriterOptions = {}
  ) {
    this.batchSize = assertPositiveInteger(options.batchSize ?? V3_TRANSFER_BATCH_SIZE, 'batch size')
    this.batchWindowMs = assertPositiveInteger(options.batchWindowMs ?? V3_TRANSFER_BATCH_WINDOW_MS, 'batch window')
    this.maxQueuedChunksPerTransfer = assertPositiveInteger(
      options.maxQueuedChunksPerTransfer ?? MAX_QUEUED_CHUNKS_PER_TRANSFER,
      'maximum queued chunk count'
    )
    this.maxQueuedChunkRequests = assertPositiveInteger(
      options.maxQueuedChunkRequests ?? MAX_QUEUED_CHUNK_REQUESTS,
      'maximum queued chunk request count'
    )
    this.maxQueuedChunkRequestsPerTransfer = assertPositiveInteger(
      options.maxQueuedChunkRequestsPerTransfer ?? MAX_QUEUED_CHUNK_REQUESTS_PER_TRANSFER,
      'maximum queued chunk request count per transfer'
    )
  }

  enqueue(chunk: V3QueuedChunk): Promise<V3ChunkAck> {
    if (!this.accepting || this.closed) {
      return Promise.reject(new V3TransportError('TRANSFER_STORAGE_CLOSED', 503))
    }
    const {created, queue} = this.getOrCreateQueue(chunk.transferId, chunk.sourceDeviceId)
    const acknowledgement = queue.enqueue(chunk)
    if (created && queue.isIdle() && queue.canBeDiscarded()) this.queues.delete(chunk.transferId)
    return acknowledgement
  }

  /**
   * Freeze one queue before persisting its paused state. The pending jobs stay
   * attached to this queue and will only become writable again after resume.
   */
  pause<T>(
    transferId: string,
    sourceDeviceId: string,
    persist: () => Promise<T>
  ): Promise<T> {
    return this.runTransferOperation(transferId, sourceDeviceId, async (queue) => {
      const paused = queue.pause()
      if (paused) await queue.waitForCurrentFlush()
      return persist()
    })
  }

  /**
   * Persist the receiving state before releasing pending chunk jobs. This
   * prevents a resumed batch from racing a still-paused database row.
   */
  resume<T>(
    transferId: string,
    sourceDeviceId: string,
    persist: () => Promise<T>
  ): Promise<T> {
    return this.runTransferOperation(transferId, sourceDeviceId, async (queue) => {
      const result = await persist()
      queue.resume()
      return result
    })
  }

  /**
   * Fence new writes and reject every non-durable job before changing the
   * database state. The database transition happens before the active flush is
   * awaited, so a late commit is rejected rather than reviving the transfer.
   */
  cancel<T>(
    transferId: string,
    sourceDeviceId: string,
    persist: () => Promise<T>
  ): Promise<T> {
    return this.runTransferOperation(transferId, sourceDeviceId, async (queue) => {
      const completionWasSealed = queue.hasCompletionBarrier()
      if (!completionWasSealed) queue.cancel()

      const result = await persist()

      // A completion barrier may already represent a completed transfer. Only
      // fence it after the database accepts cancellation.
      if (completionWasSealed) queue.cancel()
      await queue.waitForCurrentFlush()
      this.removeTerminalQueue(transferId, queue)
      return result
    })
  }

  /**
   * Atomically seals one transfer's chunk queue, then runs completion after all
   * chunks accepted before the seal have either committed or failed.
   */
  runCompletion<T>(
    transferId: string,
    sourceDeviceId: string,
    callback: () => Promise<T>
  ): Promise<T> {
    if (!this.accepting || this.closed) {
      return Promise.reject(new V3TransportError('TRANSFER_STORAGE_CLOSED', 503))
    }
    const completion = this.runTransferOperation(transferId, sourceDeviceId, async (queue) => {
      if (!queue.beginCompletionBarrier()) {
        throw new V3TransportError('TRANSFER_CLOSING', 409)
      }
      try {
        await queue.drain()
        const result = await callback()
        this.removeTerminalQueue(transferId, queue)
        return result
      } catch (error) {
        // A callback error without a durable completion result must not leave
        // an in-memory barrier that outlives the request.
        queue.releaseCompletionBarrier()
        throw error
      }
    })
    this.runningCompletions.set(transferId, completion)
    void completion.then(
      () => this.clearRunningCompletion(transferId, completion),
      () => this.clearRunningCompletion(transferId, completion)
    )
    return completion
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.accepting = false
    await Promise.all([...this.queues.values()].map((queue) => queue.stopForClose()))
    await Promise.all([...this.runningCompletions.values()].map(async (completion) => {
      try {
        await completion
      } catch {
        // Completion errors are returned to their request; shutdown still has to release storage.
      }
    }))
    this.queues.clear()
    this.closed = true
  }

  private getOrCreateQueue(transferId: string, sourceDeviceId: string) {
    const existing = this.queues.get(transferId)
    if (existing) return {created: false, queue: existing}

    const queue = new TransferWriteQueue({
      batchSize: this.batchSize,
      batchWindowMs: this.batchWindowMs,
      acquireQueuedRequest: () => this.acquireQueuedRequest(),
      maxQueuedChunks: this.maxQueuedChunksPerTransfer,
      maxQueuedRequests: this.maxQueuedChunkRequestsPerTransfer,
      nextJobId: () => this.nextJobId++,
      onCommitted: this.options.onCommitted,
      onIdle: (idleQueue) => {
        if (
          this.queues.get(idleQueue.transferId) === idleQueue
          && idleQueue.isIdle()
          && idleQueue.canBeDiscarded()
        ) {
          this.queues.delete(idleQueue.transferId)
        }
      },
      sourceDeviceId,
      stagingDirectory: this.transferStore.stagingDirectory,
      transferId,
      transferStore: this.transferStore,
      releaseQueuedRequest: () => this.releaseQueuedRequest()
    })
    this.queues.set(transferId, queue)
    return {created: true, queue}
  }

  private clearRunningCompletion(transferId: string, completion: Promise<unknown>) {
    if (this.runningCompletions.get(transferId) === completion) {
      this.runningCompletions.delete(transferId)
    }
  }

  private removeTerminalQueue(transferId: string, queue: TransferWriteQueue) {
    if (this.queues.get(transferId) === queue && queue.isIdle()) {
      this.queues.delete(transferId)
    }
  }

  private runTransferOperation<T>(
    transferId: string,
    sourceDeviceId: string,
    operation: (queue: TransferWriteQueue) => Promise<T>
  ): Promise<T> {
    const start = () => {
      const {queue} = this.getOrCreateQueue(transferId, sourceDeviceId)
      if (!queue.acceptsSourceDevice(sourceDeviceId)) {
        throw new V3TransportError('TRANSFER_FORBIDDEN', 403)
      }
      return operation(queue)
    }
    const previous = this.transferOperationTails.get(transferId)
    let result: Promise<T>
    if (previous) {
      result = previous.catch(() => undefined).then(start)
    } else {
      try {
        result = Promise.resolve(start())
      } catch (error) {
        result = Promise.reject(error)
      }
    }
    const tail = result.then(() => undefined, () => undefined)
    this.transferOperationTails.set(transferId, tail)
    void tail.finally(() => {
      if (this.transferOperationTails.get(transferId) === tail) {
        this.transferOperationTails.delete(transferId)
      }
    })
    return result
  }

  private acquireQueuedRequest() {
    if (this.queuedChunkRequests >= this.maxQueuedChunkRequests) return false
    this.queuedChunkRequests += 1
    return true
  }

  private releaseQueuedRequest() {
    this.queuedChunkRequests = Math.max(0, this.queuedChunkRequests - 1)
  }
}

type TransferWriteQueueOptions = {
  batchSize: number
  batchWindowMs: number
  acquireQueuedRequest: () => boolean
  maxQueuedChunks: number
  maxQueuedRequests: number
  nextJobId: () => number
  onCommitted?: (change: V3TransferWriterChange) => void
  onIdle: (queue: TransferWriteQueue) => void
  sourceDeviceId: string
  stagingDirectory: string
  transferId: string
  transferStore: V3TransferStore
  releaseQueuedRequest: () => void
}

class TransferWriteQueue {
  private cancelled = false
  private completionBarrier = false
  private currentFlush: Promise<void> | null = null
  private deadline: number | null = null
  private drainCount = 0
  private flushRequested = false
  private readonly jobsByKey = new Map<string, QueueJob>()
  private readonly pending: QueueJob[] = []
  private queuedRequestCount = 0
  private paused = false
  private stopping = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: TransferWriteQueueOptions) {}

  get transferId() {
    return this.options.transferId
  }

  acceptsSourceDevice(sourceDeviceId: string) {
    return sourceDeviceId === this.options.sourceDeviceId
  }

  beginCompletionBarrier() {
    if (this.completionBarrier || this.paused || this.cancelled || this.stopping) return false
    this.completionBarrier = true
    return true
  }

  hasCompletionBarrier() {
    return this.completionBarrier
  }

  canBeDiscarded() {
    return !this.completionBarrier && !this.paused && !this.cancelled && !this.stopping
  }

  pause() {
    if (this.completionBarrier || this.cancelled || this.stopping) return false
    this.paused = true
    this.clearTimer()
    this.deadline = null
    return true
  }

  resume() {
    if (this.completionBarrier || this.cancelled || this.stopping) return false
    if (!this.paused) return true
    this.paused = false
    if (this.pending.length >= this.options.batchSize) {
      this.requestFlush()
    } else {
      this.ensureTimer()
    }
    if (this.isIdle()) this.options.onIdle(this)
    return true
  }

  cancel() {
    if (this.cancelled) return true
    this.cancelled = true
    this.paused = false
    this.clearTimer()
    this.deadline = null
    this.pending.splice(0, this.pending.length)
    for (const job of [...this.jobsByKey.values()]) {
      this.rejectJob(job, new V3TransportError('TRANSFER_CLOSING', 409))
    }
    return true
  }

  async waitForCurrentFlush(): Promise<void> {
    if (this.currentFlush) await this.currentFlush
  }

  async stopForClose(): Promise<void> {
    this.stopping = true
    this.clearTimer()
    this.pending.splice(0, this.pending.length)
    for (const job of [...this.jobsByKey.values()]) {
      this.rejectJob(job, new V3TransportError('TRANSFER_STORAGE_CLOSED', 503))
    }
    await this.waitForCurrentFlush()
  }

  releaseCompletionBarrier() {
    if (!this.completionBarrier) return
    this.completionBarrier = false
    if (this.isIdle()) this.options.onIdle(this)
  }

  enqueue(chunk: V3QueuedChunk): Promise<V3ChunkAck> {
    if (this.completionBarrier || this.cancelled || this.stopping) {
      return Promise.reject(new V3TransportError('TRANSFER_CLOSING', 409))
    }
    if (this.paused) return Promise.reject(new V3TransportError('TRANSFER_PAUSED', 409))
    if (chunk.sourceDeviceId !== this.options.sourceDeviceId) {
      return Promise.reject(new V3TransportError('TRANSFER_FORBIDDEN', 403))
    }
    const key = getChunkKey(chunk.itemId, chunk.chunkIndex)
    const existing = this.jobsByKey.get(key)
    if (existing) {
      if (existing.data.length !== chunk.data.length || existing.sha256 !== chunk.sha256) {
        return Promise.reject(new V3TransportError('CHUNK_CONFLICT', 409))
      }
    }
    if (this.queuedRequestCount >= this.options.maxQueuedRequests || !this.options.acquireQueuedRequest()) {
      return Promise.reject(new V3TransportError('TRANSFER_BACKPRESSURE', 503))
    }
    if (existing) return this.attachWaiter(existing)
    if (this.jobsByKey.size >= this.options.maxQueuedChunks) {
      this.options.releaseQueuedRequest()
      return Promise.reject(new V3TransportError('TRANSFER_BACKPRESSURE', 503))
    }

    let resolve!: (ack: V3ChunkAck) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<V3ChunkAck>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const job: QueueJob = {
      ...chunk,
      enqueuedAt: Date.now(),
      id: this.options.nextJobId(),
      key,
      promise,
      reject,
      resolve,
      waiterCount: 0
    }
    this.jobsByKey.set(key, job)
    this.pending.push(job)
    this.ensureTimer()
    if (this.pending.length >= this.options.batchSize) this.requestFlush()
    return this.attachWaiter(job)
  }

  async drain(): Promise<void> {
    if (this.paused || this.cancelled || this.stopping) {
      throw new V3TransportError('TRANSFER_CLOSING', 409)
    }
    this.drainCount += 1
    try {
      this.clearTimer()
      this.flushRequested = true
      while (this.currentFlush || this.pending.length > 0) {
        if (!this.currentFlush && this.pending.length > 0) this.startFlush()
        if (this.currentFlush) await this.currentFlush
      }
    } finally {
      this.drainCount = Math.max(0, this.drainCount - 1)
    }
  }

  isIdle() {
    return this.currentFlush === null && this.pending.length === 0 && this.jobsByKey.size === 0
  }

  private ensureTimer() {
    if (this.pending.length === 0 || this.timer || this.isDraining() || this.paused || this.cancelled || this.stopping) return
    const oldestPending = this.pending[0]
    this.deadline = oldestPending.enqueuedAt + this.options.batchWindowMs
    const delay = Math.max(0, this.deadline - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushRequested = true
      this.requestFlush()
    }, delay)
  }

  private requestFlush() {
    if (this.paused || this.cancelled || this.stopping) return
    if (this.currentFlush) {
      this.flushRequested = true
      return
    }
    this.startFlush()
  }

  private startFlush() {
    if (this.currentFlush || this.pending.length === 0 || this.paused || this.cancelled || this.stopping) return
    this.clearTimer()
    this.flushRequested = false
    const batch = this.pending.splice(0, this.options.batchSize)
    this.currentFlush = this.persistBatch(batch)
    void this.currentFlush.finally(() => {
      this.currentFlush = null
      if (this.pending.length > 0) {
        if (this.paused || this.cancelled || this.stopping) return
        const deadlinePassed = this.deadline !== null && this.deadline <= Date.now()
        if (this.isDraining() || this.flushRequested || this.pending.length >= this.options.batchSize || deadlinePassed) {
          this.startFlush()
        } else {
          this.ensureTimer()
        }
        return
      }
      this.deadline = null
      this.options.onIdle(this)
    })
  }

  private async persistBatch(batch: QueueJob[]) {
    try {
      const metadata = batch.map(toChunkMetadata)
      const preflight = await this.options.transferStore.preflightChunkBatch(
        this.transferId,
        this.options.sourceDeviceId,
        metadata
      )
      const accepted = this.applyPreflight(batch, preflight)
      if (accepted.length === 0) return

      if (this.cancelled || this.stopping) return

      const newJobs = accepted.filter((entry) => entry.state === 'new').map((entry) => entry.job)
      if (newJobs.length > 0) await writeBatchToStaging(this.options.stagingDirectory, this.transferId, newJobs)

      if (this.cancelled || this.stopping) return

      const result = await this.options.transferStore.commitChunkBatch(
        this.transferId,
        this.options.sourceDeviceId,
        newJobs.map(toChunkMetadata),
        accepted.map((entry) => toChunkMetadata(entry.job))
      )
      this.resolveAcknowledgements(accepted.map((entry) => entry.job), result.acknowledgements)
      if (result.committed) {
        const revision = Math.max(...result.acknowledgements.map((entry) => entry.ack.revision))
        this.options.onCommitted?.({revision, transferId: this.transferId})
      }
    } catch (error) {
      const transportError = toTransportError(error)
      for (const job of batch) this.rejectJob(job, transportError)
    }
  }

  private applyPreflight(batch: QueueJob[], results: V3ChunkPreflightResult[]) {
    const byJobId = new Map(results.map((result) => [result.jobId, result]))
    const accepted: Array<{job: QueueJob; state: 'duplicate' | 'new'}> = []
    for (const job of batch) {
      const result = byJobId.get(job.id)
      if (!result) {
        this.rejectJob(job, new V3TransportError('TRANSFER_INTERNAL_ERROR', 500))
        continue
      }
      if (result.error) {
        this.rejectJob(job, new V3TransportError(result.error.code, result.error.statusCode))
        continue
      }
      accepted.push({job, state: result.state})
    }
    return accepted
  }

  private resolveAcknowledgements(
    jobs: QueueJob[],
    acknowledgements: Array<{ack: V3ChunkAck; jobId: number}>
  ) {
    const byJobId = new Map(acknowledgements.map((entry) => [entry.jobId, entry.ack]))
    for (const job of jobs) {
      const acknowledgement = byJobId.get(job.id)
      if (!acknowledgement) {
        this.rejectJob(job, new V3TransportError('TRANSFER_INTERNAL_ERROR', 500))
        continue
      }
      this.resolveJob(job, acknowledgement)
    }
  }

  private resolveJob(job: QueueJob, acknowledgement: V3ChunkAck) {
    if (!this.jobsByKey.delete(job.key)) return
    job.resolve(acknowledgement)
  }

  private rejectJob(job: QueueJob, error: Error) {
    if (!this.jobsByKey.delete(job.key)) return
    job.reject(error)
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private attachWaiter(job: QueueJob): Promise<V3ChunkAck> {
    job.waiterCount += 1
    this.queuedRequestCount += 1
    return job.promise.finally(() => {
      job.waiterCount -= 1
      this.queuedRequestCount = Math.max(0, this.queuedRequestCount - 1)
      this.options.releaseQueuedRequest()
    })
  }

  private isDraining() {
    return this.drainCount > 0
  }

}

function toChunkMetadata(job: QueueJob): V3ChunkMetadata {
  return {
    chunkIndex: job.chunkIndex,
    itemId: job.itemId,
    jobId: job.id,
    sha256: job.sha256,
    sizeBytes: job.data.length
  }
}

async function writeBatchToStaging(stagingDirectory: string, transferId: string, jobs: QueueJob[]) {
  const directory = path.join(stagingDirectory, transferId)
  await mkdir(directory, {recursive: true})

  const handles = new Map<string, FileHandle>()
  try {
    for (const job of jobs) {
      const stagingPath = path.join(directory, `${job.itemId}.part`)
      let handle = handles.get(stagingPath)
      if (!handle) {
        handle = await openForPositionedWrites(stagingPath)
        handles.set(stagingPath, handle)
      }
      await writeAll(handle, job.data, job.offset)
    }
    await Promise.all([...handles.values()].map((handle) => handle.sync()))
  } finally {
    await Promise.all([...handles.values()].map(async (handle) => {
      try {
        await handle.close()
      } catch {
        // Preserve a write or sync error when closing a staging handle also fails.
      }
    }))
  }
}

async function openForPositionedWrites(stagingPath: string): Promise<FileHandle> {
  try {
    return await open(stagingPath, 'r+')
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
  try {
    return await open(stagingPath, 'wx+')
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
    return open(stagingPath, 'r+')
  }
}

async function writeAll(handle: FileHandle, data: Buffer, offset: number) {
  let written = 0
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, offset + written)
    if (result.bytesWritten <= 0) throw new Error('Unable to write the complete V3 chunk.')
    written += result.bytesWritten
  }
}

function getChunkKey(itemId: string, chunkIndex: number) {
  return `${itemId}:${chunkIndex}`
}

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid V3 transfer ${name}.`)
  return value
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value && value.code === code
}

function toTransportError(value: unknown): Error {
  return value instanceof Error ? value : new V3TransportError('TRANSFER_INTERNAL_ERROR', 500)
}
