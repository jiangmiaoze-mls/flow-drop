import {createHash} from 'node:crypto'
import {rm} from 'node:fs/promises'
import path from 'node:path'

import {V3ContentVerifier} from './v3ContentVerifier'
import type {V3TrustedDeviceAccess} from './v3TrustedDeviceAccess'
import {V3TransportError} from './v3TransportError'
import {V3TransferSseDebouncer} from './v3TransferSseDebouncer'
import {
  type V3CompletionBeginResult,
  type V3CompletionVerificationPlan,
  V3TransferStore
} from './v3TransferStore'
import {V3TransferCompletionRetryableError, V3TransferWriter} from './v3TransferWriter'
import type {
  V3AdminTransferSnapshot,
  V3ChunkAck,
  V3ChunkDigestPage,
  V3CompletionFile,
  V3CreateTransferRequest,
  V3CreateTransferResponse,
  V3TransferControlResponse,
  V3TransferItem,
  V3TransferStatusSnapshot,
  V3TransportCapabilities
} from './v3TransportTypes'
import {
  V3_MAX_CHUNK_BYTES,
  V3_MAX_IN_FLIGHT_CHUNKS,
  V3_MAX_ITEMS_PER_TRANSFER,
  V3_MIN_CHUNK_BYTES,
  V3_PROTOCOL
} from './v3TransportTypes'

const MAX_FILE_NAME_LENGTH = 255

export type V3ContentRange = {end: number; start: number; total: number}

export type V3TransferChangePublisher = {
  publish: (event: {payload: {revision: number; transferId: string}; type: 'transfer.changed'}) => unknown
}

export type V3CompletionResponse = {
  response: V3TransferStatusSnapshot
  statusCode: 200 | 202
}

type ActiveCompletionStart = {
  filesKey: string
  result: Promise<V3CompletionBeginResult>
  sourceDeviceId: string
}

type VerificationProgress = {
  verifyingBytes: number
  verifyingPhase: 'idle' | 'reading' | 'hashing' | 'done'
  verifyingTotalBytes: number
}

type VerificationTask = {
  controller: AbortController
  task: Promise<void>
  transferId: string
}

export class V3TransferService {
  private readonly changeDebouncer: V3TransferSseDebouncer | null
  private readonly cancellationCleanups = new Map<string, Promise<void>>()
  private readonly cancellationFences = new Set<string>()
  private readonly cancelledStagingCleanup: Promise<void>
  private readonly completionStarts = new Map<string, ActiveCompletionStart>()
  private readonly contentVerifier = new V3ContentVerifier()
  private readonly transferWriter: V3TransferWriter
  private readonly verificationPlans = new Map<string, V3CompletionVerificationPlan>()
  private readonly verificationTasks = new Map<string, VerificationTask>()

  constructor(
    private readonly trustedDeviceAccess: V3TrustedDeviceAccess,
    private readonly transferStore = new V3TransferStore(),
    changePublisher?: V3TransferChangePublisher
  ) {
    this.changeDebouncer = changePublisher
      ? new V3TransferSseDebouncer((change) => {
        changePublisher.publish({payload: change, type: 'transfer.changed'})
      })
      : null
    this.transferWriter = new V3TransferWriter(this.transferStore, {
      onCommitted: (change) => this.changeDebouncer?.notify(change)
    })
    this.cancelledStagingCleanup = this.cleanupCancelledStagingOnStartup()
    void this.cancelledStagingCleanup.catch(() => undefined)
  }

  async close(): Promise<void> {
    for (const verification of this.verificationTasks.values()) verification.controller.abort()
    await this.transferWriter.close()
    await Promise.allSettled([...this.verificationTasks.values()].map((verification) => verification.task))
    await this.cancelledStagingCleanup
    this.changeDebouncer?.close()
    await this.transferStore.close()
  }

  async getCapabilities(sourceDeviceId: string): Promise<V3TransportCapabilities> {
    await this.assertReceivePermission(sourceDeviceId)
    return {
      maxChunkBytes: V3_MAX_CHUNK_BYTES,
      maxInFlightChunks: V3_MAX_IN_FLIGHT_CHUNKS,
      protocols: [V3_PROTOCOL]
    }
  }

  async createIncomingTransfer(
    value: unknown,
    authenticatedSourceDeviceId: string
  ): Promise<{created: boolean; response: V3CreateTransferResponse}> {
    const request = validateV3CreateTransferRequest(value)
    if (request.sourceDeviceId !== authenticatedSourceDeviceId) {
      throw new V3TransportError('TRANSFER_FORBIDDEN', 403)
    }
    await this.assertReceivePermission(authenticatedSourceDeviceId)
    const result = await this.transferStore.createOrGet(request)
    if (result.created) {
      this.changeDebouncer?.notify({revision: result.response.revision, transferId: result.response.transferId})
    }
    return result
  }

  async uploadChunk(
    transferId: string,
    itemId: string,
    chunkIndex: number,
    authenticatedSourceDeviceId: string,
    contentRange: V3ContentRange,
    data: Buffer,
    expectedChunkSha256: string
  ): Promise<V3ChunkAck> {
    const target = await this.transferStore.getChunkWriteTarget(transferId, itemId)
    if (!target) throw new V3TransportError('TRANSFER_NOT_FOUND', 404)
    if (target.sourceDeviceId !== authenticatedSourceDeviceId) {
      throw new V3TransportError('TRANSFER_FORBIDDEN', 403)
    }
    if (target.status === 'paused') {
      throw new V3TransportError('TRANSFER_PAUSED', 409)
    }
    if (target.status !== 'negotiating' && target.status !== 'transferring') {
      throw new V3TransportError('TRANSFER_CLOSING', 409)
    }
    await this.assertReceivePermission(authenticatedSourceDeviceId)

    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !isSha256(expectedChunkSha256)) {
      throw new V3TransportError('INVALID_CHUNK', 400)
    }
    const start = chunkIndex * target.chunkSizeBytes
    const expectedLength = Math.min(target.chunkSizeBytes, target.itemSizeBytes - start)
    if (!Number.isSafeInteger(start) || expectedLength <= 0 || data.length !== expectedLength) {
      throw new V3TransportError('INVALID_CONTENT_RANGE', 400)
    }
    if (
      contentRange.start !== start
      || contentRange.end !== start + data.length - 1
      || contentRange.total !== target.itemSizeBytes
    ) {
      throw new V3TransportError('INVALID_CONTENT_RANGE', 400)
    }

    const digest = createHash('sha256').update(data).digest('hex')
    if (digest !== expectedChunkSha256.toLowerCase()) {
      throw new V3TransportError('CHUNK_HASH_MISMATCH', 422)
    }
    return this.transferWriter.enqueue({
      chunkIndex,
      data,
      itemId,
      offset: start,
      sha256: digest,
      sourceDeviceId: authenticatedSourceDeviceId,
      transferId
    })
  }

  listIncomingTransfersForAdmin(): Promise<V3AdminTransferSnapshot[]> {
    return this.transferStore.listForAdmin()
  }

  async getIncomingTransferStatus(
    transferId: string,
    authenticatedSourceDeviceId: string
  ): Promise<V3TransferStatusSnapshot> {
    await this.assertReceivePermission(authenticatedSourceDeviceId)
    return this.transferStore.getStatus(transferId, authenticatedSourceDeviceId)
  }

  async getIncomingChunkDigests(
    transferId: string,
    itemId: string,
    authenticatedSourceDeviceId: string,
    offset: number,
    limit: number
  ): Promise<V3ChunkDigestPage> {
    await this.assertReceivePermission(authenticatedSourceDeviceId)
    return this.transferStore.getChunkDigests(transferId, itemId, authenticatedSourceDeviceId, offset, limit)
  }

  async pauseIncomingTransfer(
    transferId: string,
    authenticatedSourceDeviceId: string
  ): Promise<V3TransferControlResponse> {
    await this.assertReceivePermission(authenticatedSourceDeviceId)
    const current = await this.transferStore.getStatus(transferId, authenticatedSourceDeviceId)
    if (current.status !== 'paused' && !isPausableTransferStatus(current.status)) {
      throw new V3TransportError('TRANSFER_STATE_INVALID', 409)
    }
    const response = await this.transferWriter.pause(
      transferId,
      authenticatedSourceDeviceId,
      () => this.transferStore.pauseTransfer(transferId, authenticatedSourceDeviceId)
    )
    this.notifyControlResponse(transferId, response)
    return response
  }

  async resumeIncomingTransfer(
    transferId: string,
    authenticatedSourceDeviceId: string
  ): Promise<V3TransferControlResponse> {
    await this.assertReceivePermission(authenticatedSourceDeviceId)
    const current = await this.transferStore.getStatus(transferId, authenticatedSourceDeviceId)
    if (current.status !== 'paused' && current.status !== 'transferring') {
      throw new V3TransportError('TRANSFER_STATE_INVALID', 409)
    }
    const response = await this.transferWriter.resume(
      transferId,
      authenticatedSourceDeviceId,
      () => this.transferStore.resumeTransfer(transferId, authenticatedSourceDeviceId)
    )
    this.notifyControlResponse(transferId, response)
    return response
  }

  async cancelIncomingTransfer(
    transferId: string,
    authenticatedSourceDeviceId: string
  ): Promise<V3TransferControlResponse> {
    await this.assertReceivePermission(authenticatedSourceDeviceId)
    const current = await this.transferStore.getStatus(transferId, authenticatedSourceDeviceId)
    if (current.status !== 'cancelled' && current.status !== 'paused' && current.status !== 'completing' && !isPausableTransferStatus(current.status)) {
      throw new V3TransportError('TRANSFER_STATE_INVALID', 409)
    }
    this.cancellationFences.add(transferId)
    try {
      const response = await this.transferWriter.cancel(
        transferId,
        authenticatedSourceDeviceId,
        () => this.transferStore.cancelTransfer(transferId, authenticatedSourceDeviceId)
      )
      await this.abortVerification(transferId)
      await this.removeCancelledStaging(transferId)
      this.notifyControlResponse(transferId, response)
      return response
    } catch (error) {
      await this.restoreVerificationAfterCancelledControlFailure(transferId, authenticatedSourceDeviceId)
      throw error
    }
  }

  async completeIncomingTransfer(
    transferId: string,
    value: unknown,
    authenticatedSourceDeviceId: string
  ): Promise<V3CompletionResponse> {
    const files = validateV3CompletionRequest(value)
    await this.assertReceivePermission(authenticatedSourceDeviceId)
    const initial = await this.transferStore.getStatus(transferId, authenticatedSourceDeviceId)
    assertExactCompletionItemOrder(files, initial)

    const filesKey = JSON.stringify(files)
    const active = this.completionStarts.get(transferId)
    if (active) {
      if (active.sourceDeviceId !== authenticatedSourceDeviceId) {
        throw new V3TransportError('TRANSFER_FORBIDDEN', 403)
      }
      if (active.filesKey !== filesKey) {
        throw new V3TransportError('TRANSFER_COMPLETION_CONFLICT', 409)
      }
      return toCompletionResponse(await active.result)
    }

    const result = this.beginCompletion(transferId, authenticatedSourceDeviceId, files, initial)
    const entry: ActiveCompletionStart = {filesKey, result, sourceDeviceId: authenticatedSourceDeviceId}
    this.completionStarts.set(transferId, entry)
    try {
      return toCompletionResponse(await result)
    } finally {
      if (this.completionStarts.get(transferId) === entry) this.completionStarts.delete(transferId)
    }
  }

  private async beginCompletion(
    transferId: string,
    sourceDeviceId: string,
    files: V3CompletionFile[],
    initial: V3TransferStatusSnapshot
  ): Promise<V3CompletionBeginResult> {
    let result: V3CompletionBeginResult

    if (initial.status === 'negotiating' || initial.status === 'transferring') {
      try {
        result = await this.transferWriter.runCompletion(transferId, sourceDeviceId, async () => {
          try {
            return await this.transferStore.beginCompletion(transferId, sourceDeviceId, files)
          } catch (error) {
            if (isRetryableCompletionError(error)) {
              throw new V3TransferCompletionRetryableError(error)
            }
            throw error
          }
        })
      } catch (error) {
        if (error instanceof V3TransferCompletionRetryableError) throw error.cause
        if (!(error instanceof V3TransportError) || error.code !== 'TRANSFER_CLOSING') throw error
        result = await this.transferStore.beginCompletion(transferId, sourceDeviceId, files)
      }
    } else {
      result = await this.transferStore.beginCompletion(transferId, sourceDeviceId, files)
    }

    this.notifySnapshot(transferId, result.snapshot)
    if (result.disposition === 'failed') throw toCompletionFailure(result.snapshot)

    if (result.snapshot.status === 'completing') {
      const plan = result.verificationPlan
        ?? await this.transferStore.getCompletionVerificationPlan(transferId, result.completionAttempt)
      if (plan) {
        this.verificationPlans.set(transferId, plan)
        this.startVerification(plan)
      }
    }
    return result
  }

  private startVerification(plan: V3CompletionVerificationPlan) {
    if (this.cancellationFences.has(plan.transferId)) return
    const key = getVerificationKey(plan)
    if (this.verificationTasks.has(key)) return

    const controller = new AbortController()
    const task = this.verifyCompletion(plan, controller.signal)
    const entry: VerificationTask = {controller, task, transferId: plan.transferId}
    this.verificationTasks.set(key, entry)
    void task.finally(() => {
      if (this.verificationTasks.get(key) === entry) this.verificationTasks.delete(key)
    })
  }

  private async verifyCompletion(plan: V3CompletionVerificationPlan, signal: AbortSignal) {
    const initialProgress: VerificationProgress = {
      verifyingBytes: 0,
      verifyingPhase: 'idle',
      verifyingTotalBytes: plan.items.reduce((total, item) => total + item.sizeBytes, 0)
    }
    let latestProgress = initialProgress
    let progressChain = Promise.resolve()

    try {
      const verification = await this.contentVerifier.verify({
        chunkSizeBytes: plan.chunkSizeBytes,
        expectedItems: plan.items,
        stagingDirectory: this.transferStore.stagingDirectory,
        transferId: plan.transferId
      }, (progress) => {
        const progressSnapshot: VerificationProgress = {
          verifyingBytes: progress.verifyingBytes,
          verifyingPhase: progress.verifyingPhase,
          verifyingTotalBytes: progress.verifyingTotalBytes
        }
        latestProgress = progressSnapshot
        progressChain = progressChain.then(async () => {
          const mutation = await this.transferStore.setVerificationProgress(
            plan.transferId,
            plan.completionAttempt,
            progressSnapshot.verifyingBytes,
            progressSnapshot.verifyingTotalBytes,
            progressSnapshot.verifyingPhase
          )
          if (mutation.applied) this.notifySnapshot(plan.transferId, mutation.snapshot)
        }).catch(() => {
          // A stale verification attempt or a closing store must not crash the Agent process.
        })
      }, signal)
      await progressChain

      if (verification.items.some((item) => 'error' in item)) {
        const errorCode = verification.items.some((item) => {
          return 'error' in item && item.error.code === 'PART_CONTENT_ROOT_MISMATCH'
        }) ? 'PART_CONTENT_ROOT_MISMATCH' : 'PART_READ_ERROR'
        const mutation = await this.transferStore.markTransferFailed(
          plan.transferId,
          plan.completionAttempt,
          errorCode,
          latestProgress.verifyingBytes,
          latestProgress.verifyingTotalBytes,
          latestProgress.verifyingPhase
        )
        if (mutation.applied) {
          this.notifySnapshot(plan.transferId, mutation.snapshot)
          this.forgetVerificationPlan(plan)
        }
        return
      }

      const mutation = await this.transferStore.markTransferCompleted(
        plan.transferId,
        plan.completionAttempt,
        verification.items.filter(isVerifiedContentItem).map((item) => ({
          contentRoot: item.actualContentRoot,
          itemId: item.itemId
        }))
      )
      if (mutation.applied) {
        this.notifySnapshot(plan.transferId, mutation.snapshot)
        this.forgetVerificationPlan(plan)
      }
    } catch {
      // Only an item-local verifier result can prove a .part read failure. Keep
      // the transfer completing for an explicit same-root completion retry when
      // worker startup, IPC, or a database mutation itself fails.
    }
  }

  private notifySnapshot(transferId: string, snapshot: V3TransferStatusSnapshot) {
    this.changeDebouncer?.notify({revision: snapshot.revision, transferId})
  }

  private notifyControlResponse(transferId: string, response: V3TransferControlResponse) {
    this.changeDebouncer?.notify({revision: response.revision, transferId})
  }

  private async abortVerification(transferId: string) {
    const tasks = [...this.verificationTasks.values()].filter((entry) => entry.transferId === transferId)
    for (const entry of tasks) entry.controller.abort()
    await Promise.allSettled(tasks.map((entry) => entry.task))
  }

  private forgetVerificationPlan(plan: V3CompletionVerificationPlan) {
    const current = this.verificationPlans.get(plan.transferId)
    if (current?.completionAttempt === plan.completionAttempt) {
      this.verificationPlans.delete(plan.transferId)
    }
  }

  private async restoreVerificationAfterCancelledControlFailure(transferId: string, sourceDeviceId: string) {
    try {
      const snapshot = await this.transferStore.getStatus(transferId, sourceDeviceId)
      if (snapshot.status === 'cancelled') return
    } catch {
      // A failed status read cannot safely reopen a cancelled verification task.
      return
    }
    this.cancellationFences.delete(transferId)
    const plan = this.verificationPlans.get(transferId)
    if (plan) this.startVerification(plan)
  }

  private async cleanupCancelledStagingOnStartup() {
    try {
      const transferIds = await this.transferStore.listCancelledTransferIds()
      await Promise.allSettled(transferIds.map((transferId) => this.removeCancelledStaging(transferId)))
    } catch {
      // Cancelled transfers retain their cleanup intent in SQLite and will be
      // retried by an idempotent cancel request or the next process start.
    }
  }

  private removeCancelledStaging(transferId: string): Promise<void> {
    const existing = this.cancellationCleanups.get(transferId)
    if (existing) return existing
    const stagingRoot = path.resolve(this.transferStore.stagingDirectory)
    const transferDirectory = path.resolve(stagingRoot, transferId)
    if (path.dirname(transferDirectory) !== stagingRoot) {
      return Promise.reject(new V3TransportError('INVALID_TRANSFER', 400))
    }
    const cleanup = rm(transferDirectory, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100
    }).finally(() => {
      if (this.cancellationCleanups.get(transferId) === cleanup) {
        this.cancellationCleanups.delete(transferId)
      }
    })
    this.cancellationCleanups.set(transferId, cleanup)
    return cleanup
  }

  private async assertReceivePermission(sourceDeviceId: string): Promise<void> {
    let device
    try {
      device = await this.trustedDeviceAccess.get(sourceDeviceId)
    } catch {
      throw new V3TransportError('TRANSFER_AUTHORIZATION_UNAVAILABLE', 503)
    }
    if (!device) throw new V3TransportError('DEVICE_NOT_PAIRED', 403)
    if (!device.receiveEnabled) throw new V3TransportError('TRANSFER_RECEIVE_DISABLED', 403)
  }
}

export function parseV3ContentRange(value: unknown): V3ContentRange | null {
  if (typeof value !== 'string') return null
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) return null
  if (start < 0 || end < start || total <= end) return null
  return {end, start, total}
}

export function parseV3ChunkIndex(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function validateV3CreateTransferRequest(value: unknown): V3CreateTransferRequest {
  if (!isRecord(value)) throw new V3TransportError('INVALID_TRANSFER', 400)
  assertExactKeys(value, ['chunkSizeBytes', 'items', 'protocol', 'sourceDeviceId', 'transferId'])
  const transferId = value.transferId
  const sourceDeviceId = value.sourceDeviceId
  const chunkSizeBytes = value.chunkSizeBytes
  if (value.protocol !== V3_PROTOCOL || !isIdentifier(transferId) || !isIdentifier(sourceDeviceId)) {
    throw new V3TransportError('INVALID_TRANSFER', 400)
  }
  if (!isChunkSize(chunkSizeBytes)) {
    throw new V3TransportError('INVALID_TRANSFER_CHUNK_SIZE', 400)
  }
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > V3_MAX_ITEMS_PER_TRANSFER) {
    throw new V3TransportError('INVALID_TRANSFER_ITEMS', 400)
  }

  const itemIds = new Set<string>()
  const items: V3TransferItem[] = []
  let totalBytes = 0
  for (const item of value.items) {
    if (!isRecord(item)) throw new V3TransportError('INVALID_TRANSFER_ITEM', 400)
    assertExactKeys(item, ['itemId', 'mimeType', 'name', 'sizeBytes'])
    const itemId = item.itemId
    const name = item.name
    const mimeType = item.mimeType
    const sizeBytes = item.sizeBytes
    if (!isIdentifier(itemId) || itemIds.has(itemId) || !isFileName(name) || !isMimeType(mimeType) || !isSize(sizeBytes)) {
      throw new V3TransportError('INVALID_TRANSFER_ITEM', 400)
    }
    itemIds.add(itemId)
    totalBytes += sizeBytes
    if (!Number.isSafeInteger(totalBytes)) throw new V3TransportError('INVALID_TRANSFER_ITEMS', 400)
    items.push({
      itemId,
      mimeType,
      name,
      sizeBytes
    })
  }

  return {
    chunkSizeBytes,
    items,
    protocol: V3_PROTOCOL,
    sourceDeviceId,
    transferId
  }
}

function validateV3CompletionRequest(value: unknown): V3CompletionFile[] {
  if (!isRecord(value)) throw new V3TransportError('INVALID_COMPLETION_FILES', 400)
  assertExactKeys(value, ['files'], 'INVALID_COMPLETION_FILES')
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > V3_MAX_ITEMS_PER_TRANSFER) {
    throw new V3TransportError('INVALID_COMPLETION_FILES', 400)
  }

  const itemIds = new Set<string>()
  return value.files.map((file) => {
    if (!isRecord(file)) throw new V3TransportError('INVALID_COMPLETION_FILES', 400)
    assertExactKeys(file, ['contentRoot', 'itemId'], 'INVALID_COMPLETION_FILES')
    if (!isIdentifier(file.itemId) || itemIds.has(file.itemId) || !isContentRoot(file.contentRoot)) {
      throw new V3TransportError('INVALID_COMPLETION_FILES', 400)
    }
    itemIds.add(file.itemId)
    return {contentRoot: file.contentRoot, itemId: file.itemId}
  })
}

function assertExactCompletionItemOrder(files: V3CompletionFile[], snapshot: V3TransferStatusSnapshot) {
  if (
    files.length !== snapshot.items.length
    || !files.every((file, index) => file.itemId === snapshot.items[index]?.itemId)
  ) {
    throw new V3TransportError('INVALID_COMPLETION_FILES', 400)
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], code = 'INVALID_TRANSFER') {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || !expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new V3TransportError(code, 400)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isFileName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_FILE_NAME_LENGTH
    && value.trim().length > 0
    && !/[<>:"/\\|?*\u0000-\u001F]/.test(value)
}

function isMimeType(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) && value.length <= 127
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isChunkSize(value: unknown): value is number {
  return isSize(value) && value >= V3_MIN_CHUNK_BYTES && value <= V3_MAX_CHUNK_BYTES
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function isContentRoot(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isRetryableCompletionError(error: unknown): error is V3TransportError {
  return error instanceof V3TransportError
    && (error.code === 'INVALID_COMPLETION_FILES' || error.code === 'TRANSFER_INCOMPLETE')
}

function isPausableTransferStatus(status: V3TransferStatusSnapshot['status']) {
  return status === 'negotiating'
    || status === 'queued'
    || status === 'waiting_for_peer'
    || status === 'preparing'
    || status === 'recovering'
    || status === 'transferring'
}

function toCompletionResponse(result: V3CompletionBeginResult): V3CompletionResponse {
  return {
    response: result.snapshot,
    statusCode: result.snapshot.status === 'completed' ? 200 : 202
  }
}

function toCompletionFailure(snapshot: V3TransferStatusSnapshot): V3TransportError {
  const code = snapshot.errorCode ?? 'TRANSFER_COMPLETION_FAILED'
  return new V3TransportError(code, code === 'CONTENT_ROOT_MISMATCH' ? 422 : 409)
}

function getVerificationKey(plan: V3CompletionVerificationPlan): string {
  return `${plan.transferId}:${plan.completionAttempt}`
}

function isVerifiedContentItem(
  item: {itemId: string} & ({actualContentRoot: string} | {error: unknown})
): item is {actualContentRoot: string; itemId: string} {
  return 'actualContentRoot' in item
}
