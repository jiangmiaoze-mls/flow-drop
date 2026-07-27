import os from 'node:os'
import path from 'node:path'
import {Worker} from 'node:worker_threads'

import {V3TransportError} from './v3TransportError'
import type {
  V3AdminTransferSnapshot,
  V3ChunkAck,
  V3ChunkDigestPage,
  V3CompletionFile,
  V3CreateTransferResponse,
  V3TransferControlResponse,
  V3TransferStatusSnapshot
} from './v3TransportTypes'
import type {
  V3ChunkBatchCommitResult,
  V3ChunkMetadata,
  V3ChunkPreflightResult,
  V3ChunkWriteTarget,
  V3CompletionBeginResult,
  V3CompletionMutationResult,
  V3CompletionVerificationPlan,
  V3SerializedTransferError,
  V3TransferCreation,
  V3TransferWorkerRequest,
  V3TransferWorkerResponse
} from './v3TransferWorkerProtocol'

export type {
  V3ChunkMetadata,
  V3ChunkPreflightResult,
  V3ChunkWriteTarget,
  V3CompletionBeginResult,
  V3CompletionMutationResult,
  V3CompletionVerificationPlan,
  V3TransferCreation
} from './v3TransferWorkerProtocol'

type PendingRequest = {
  reject: (reason: Error) => void
  resolve: (value: any) => void
}

export class V3TransferStore {
  readonly stagingDirectory: string

  private closePromise: Promise<void> | null = null
  private closed = false
  private closing = false
  private failure: Error | null = null
  private nextRequestId = 1
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly ready: Promise<void>
  private rejectReady!: (reason: Error) => void
  private resolveReady!: () => void
  private readonly worker: Worker

  constructor(rootDirectory = getV3TransferRoot()) {
    this.stagingDirectory = path.join(rootDirectory, 'staging-v3')
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.ready.catch(() => undefined)
    this.worker = new Worker(getV3TransferWorkerPath(), {workerData: {rootDirectory}})
    this.worker.on('message', (message: unknown) => this.handleWorkerMessage(message))
    this.worker.on('error', (error) => this.handleWorkerFailure(toError(error)))
    this.worker.on('exit', (code) => {
      if (!this.closed) {
        this.handleWorkerFailure(new Error(`V3 transfer database worker stopped with exit code ${code}.`))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      try {
        if (!this.failure) {
          await this.ready
          await this.request({type: 'close'}, true)
        }
      } catch {
        // The worker may already have failed; terminating it still releases its handles.
      } finally {
        this.closed = true
        this.rejectPendingRequests(new Error('V3 transfer database worker is closed.'))
        await this.worker.terminate()
      }
    })()
    return this.closePromise
  }

  createOrGet(creation: V3TransferCreation): Promise<{created: boolean; response: V3CreateTransferResponse}> {
    return this.request({creation, type: 'createOrGet'})
  }

  getChunkWriteTarget(transferId: string, itemId: string): Promise<V3ChunkWriteTarget | null> {
    return this.request({itemId, transferId, type: 'getChunkWriteTarget'})
  }

  getChunkAck(transferId: string, itemId: string, chunkIndex: number): Promise<V3ChunkAck> {
    return this.request({chunkIndex, itemId, transferId, type: 'getChunkAck'})
  }

  preflightChunkBatch(
    transferId: string,
    sourceDeviceId: string,
    chunks: V3ChunkMetadata[]
  ): Promise<V3ChunkPreflightResult[]> {
    return this.request({chunks, sourceDeviceId, transferId, type: 'preflightChunkBatch'})
  }

  commitChunkBatch(
    transferId: string,
    sourceDeviceId: string,
    newChunks: V3ChunkMetadata[],
    acknowledgementChunks: V3ChunkMetadata[]
  ): Promise<V3ChunkBatchCommitResult> {
    return this.request({
      acknowledgementChunks,
      newChunks,
      sourceDeviceId,
      transferId,
      type: 'commitChunkBatch'
    })
  }

  beginCompletion(
    transferId: string,
    sourceDeviceId: string,
    files: V3CompletionFile[]
  ): Promise<V3CompletionBeginResult> {
    return this.request({files, sourceDeviceId, transferId, type: 'beginCompletion'})
  }

  pauseTransfer(transferId: string, sourceDeviceId: string): Promise<V3TransferControlResponse> {
    return this.request({sourceDeviceId, transferId, type: 'pauseTransfer'})
  }

  resumeTransfer(transferId: string, sourceDeviceId: string): Promise<V3TransferControlResponse> {
    return this.request({sourceDeviceId, transferId, type: 'resumeTransfer'})
  }

  cancelTransfer(transferId: string, sourceDeviceId: string): Promise<V3TransferControlResponse> {
    return this.request({sourceDeviceId, transferId, type: 'cancelTransfer'})
  }

  getStatus(transferId: string, sourceDeviceId: string): Promise<V3TransferStatusSnapshot> {
    return this.request({sourceDeviceId, transferId, type: 'getStatus'})
  }

  getChunkDigests(
    transferId: string,
    itemId: string,
    sourceDeviceId: string,
    offset: number,
    limit: number
  ): Promise<V3ChunkDigestPage> {
    return this.request({itemId, limit, offset, sourceDeviceId, transferId, type: 'getChunkDigests'})
  }

  getCompletionVerificationPlan(
    transferId: string,
    completionAttempt: number
  ): Promise<V3CompletionVerificationPlan | null> {
    return this.request({completionAttempt, transferId, type: 'getCompletionVerificationPlan'})
  }

  setVerificationProgress(
    transferId: string,
    completionAttempt: number,
    verifyingBytes: number,
    verifyingTotalBytes: number,
    verifyingPhase: 'idle' | 'reading' | 'hashing' | 'done'
  ): Promise<V3CompletionMutationResult> {
    return this.request({
      completionAttempt,
      transferId,
      type: 'setVerificationProgress',
      verifyingBytes,
      verifyingPhase,
      verifyingTotalBytes
    })
  }

  markTransferCompleted(
    transferId: string,
    completionAttempt: number,
    actualFiles: V3CompletionFile[]
  ): Promise<V3CompletionMutationResult> {
    return this.request({actualFiles, completionAttempt, transferId, type: 'markTransferCompleted'})
  }

  markTransferFailed(
    transferId: string,
    completionAttempt: number,
    errorCode: 'PART_CONTENT_ROOT_MISMATCH' | 'PART_READ_ERROR',
    verifyingBytes: number,
    verifyingTotalBytes: number,
    verifyingPhase: 'idle' | 'reading' | 'hashing' | 'done'
  ): Promise<V3CompletionMutationResult> {
    return this.request({
      completionAttempt,
      errorCode,
      transferId,
      type: 'markTransferFailed',
      verifyingBytes,
      verifyingPhase,
      verifyingTotalBytes
    })
  }

  listForAdmin(): Promise<V3AdminTransferSnapshot[]> {
    return this.request({type: 'listForAdmin'})
  }

  listCancelledTransferIds(): Promise<string[]> {
    return this.request({type: 'listCancelledTransferIds'})
  }

  private async request<T>(payload: V3TransferWorkerRequest['payload'], allowClosing = false): Promise<T> {
    await this.ready
    if (this.failure) throw this.failure
    if (this.closed || (this.closing && !allowClosing)) {
      throw new Error('V3 transfer database worker is closed.')
    }

    const id = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {reject, resolve})
      try {
        this.worker.postMessage({id, payload} satisfies V3TransferWorkerRequest)
      } catch (error) {
        this.pendingRequests.delete(id)
        reject(toError(error))
      }
    })
  }

  private handleWorkerMessage(message: unknown) {
    if (isRecord(message) && message.type === 'ready') {
      this.resolveReady()
      return
    }
    if (!isWorkerResponse(message)) return

    const pending = this.pendingRequests.get(message.id)
    if (!pending) return
    this.pendingRequests.delete(message.id)
    if (message.error) {
      pending.reject(deserializeWorkerError(message.error))
      return
    }
    pending.resolve(message.result)
  }

  private handleWorkerFailure(error: Error) {
    if (this.closed || this.failure) return
    this.failure = error
    this.rejectReady(error)
    this.rejectPendingRequests(error)
  }

  private rejectPendingRequests(error: Error) {
    for (const pending of this.pendingRequests.values()) pending.reject(error)
    this.pendingRequests.clear()
  }
}

export function getV3TransferRoot() {
  const configuredRoot = process.env.FLOWDROP_TRANSFER_ROOT
  if (configuredRoot) return configuredRoot
  const dataDirectory = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(dataDirectory, 'FlowDrop', 'transfers')
}

export function getV3TransferDatabasePath(rootDirectory = getV3TransferRoot()) {
  return path.join(rootDirectory, 'transfers.sqlite')
}

function getV3TransferWorkerPath() {
  return __filename.endsWith('.ts')
    ? path.resolve(__dirname, '../../dist/transfers/v3TransferDatabaseWorker.js')
    : path.join(__dirname, 'v3TransferDatabaseWorker.js')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isWorkerResponse(value: unknown): value is V3TransferWorkerResponse {
  return isRecord(value) && typeof value.id === 'number'
}

function deserializeWorkerError(error: V3SerializedTransferError): Error {
  if (typeof error.code === 'string' && typeof error.statusCode === 'number') {
    return new V3TransportError(error.code, error.statusCode)
  }
  return new Error(error.message || 'V3 transfer database worker failed.')
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('V3 transfer database worker failed.')
}
