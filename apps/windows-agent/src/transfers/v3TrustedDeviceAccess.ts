import path from 'node:path'
import {Worker} from 'node:worker_threads'

export type V3TrustedDeviceAccessRecord = {
  receiveEnabled: boolean
  transferSecret: string | null
}

/**
 * V3's only dependency on paired-device state. Implementations must never do
 * synchronous I/O on the Agent event loop.
 */
export interface V3TrustedDeviceAccess {
  get(deviceId: string): Promise<V3TrustedDeviceAccessRecord | null>
}

export const V3_TRUSTED_DEVICE_ACCESS_MAX_OUTSTANDING_REQUESTS = 64
// Worker startup can legitimately exceed one second under process contention.
// This remains asynchronous, so a longer grace period cannot block the Agent
// event loop; explicit callers/tests can still request a shorter timeout.
export const V3_TRUSTED_DEVICE_ACCESS_REQUEST_TIMEOUT_MS = 5_000

export type V3TrustedDeviceAccessOptions = {
  maxOutstandingRequests?: number
  requestTimeoutMs?: number
}

export class V3TrustedDeviceAccessBackpressureError extends Error {
  constructor() {
    super('V3 trusted-device access is at capacity.')
    this.name = 'V3TrustedDeviceAccessBackpressureError'
  }
}

export class V3TrustedDeviceAccessTimeoutError extends Error {
  constructor() {
    super('V3 trusted-device access timed out.')
    this.name = 'V3TrustedDeviceAccessTimeoutError'
  }
}

type V3TrustedDeviceAccessWorkerRequest = {
  deviceId: string
  id: number
  type: 'get'
}

type V3TrustedDeviceAccessWorkerResponse = {
  error?: string
  id: number
  result?: V3TrustedDeviceAccessRecord | null
}

type PendingRequest = {
  reject: (reason: Error) => void
  resolve: (value: V3TrustedDeviceAccessRecord | null) => void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * Reads trusted-device state through a dedicated SQLite worker. Pairing and
 * device-management retain ownership of their existing synchronous store;
 * V3 transport code only performs asynchronous RPC through this client.
 */
export class V3TrustedDeviceAccessClient implements V3TrustedDeviceAccess {
  private closePromise: Promise<void> | null = null
  private closed = false
  private failure: Error | null = null
  private nextRequestId = 1
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly outstandingRequestIds = new Set<number>()
  private readonly maxOutstandingRequests: number
  private readonly requestTimeoutMs: number
  private readonly worker: Worker

  constructor(databasePath: string, options: V3TrustedDeviceAccessOptions = {}) {
    this.maxOutstandingRequests = assertPositiveInteger(
      options.maxOutstandingRequests ?? V3_TRUSTED_DEVICE_ACCESS_MAX_OUTSTANDING_REQUESTS,
      'maximum outstanding request count'
    )
    this.requestTimeoutMs = assertPositiveInteger(
      options.requestTimeoutMs ?? V3_TRUSTED_DEVICE_ACCESS_REQUEST_TIMEOUT_MS,
      'request timeout'
    )
    this.worker = new Worker(getV3TrustedDeviceAccessWorkerPath(), {
      workerData: {databasePath}
    })
    this.worker.on('message', (message: unknown) => this.handleWorkerMessage(message))
    this.worker.on('error', (error) => this.handleWorkerFailure(toError(error)))
    this.worker.on('exit', (code) => {
      if (!this.closed) {
        this.handleWorkerFailure(new Error(`V3 trusted-device access worker stopped with exit code ${code}.`))
      }
    })
  }

  get(deviceId: string): Promise<V3TrustedDeviceAccessRecord | null> {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 512) {
      return Promise.resolve(null)
    }
    return this.request({deviceId, type: 'get'})
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.rejectPendingRequests(new Error('V3 trusted-device access worker is closed.'))
    this.outstandingRequestIds.clear()
    this.closePromise = this.worker.terminate().then(() => undefined)
    return this.closePromise
  }

  private request(
    request: Omit<V3TrustedDeviceAccessWorkerRequest, 'id'>
  ): Promise<V3TrustedDeviceAccessRecord | null> {
    if (this.closed || this.failure) {
      return Promise.reject(this.failure ?? new Error('V3 trusted-device access worker is closed.'))
    }
    if (this.outstandingRequestIds.size >= this.maxOutstandingRequests) {
      return Promise.reject(new V3TrustedDeviceAccessBackpressureError())
    }

    const id = this.nextRequestId++
    return new Promise<V3TrustedDeviceAccessRecord | null>((resolve, reject) => {
      const timeout = setTimeout(() => this.handleRequestTimeout(id), this.requestTimeoutMs)
      this.pendingRequests.set(id, {reject, resolve, timeout})
      this.outstandingRequestIds.add(id)
      try {
        this.worker.postMessage({id, ...request} satisfies V3TrustedDeviceAccessWorkerRequest)
      } catch (error) {
        this.outstandingRequestIds.delete(id)
        this.rejectPendingRequest(id, toError(error))
      }
    })
  }

  private handleWorkerMessage(message: unknown) {
    if (!isWorkerResponse(message)) return
    this.outstandingRequestIds.delete(message.id)
    const pending = this.pendingRequests.get(message.id)
    if (!pending) return
    this.pendingRequests.delete(message.id)
    clearTimeout(pending.timeout)
    if (message.error) {
      pending.reject(new Error('V3 trusted-device access worker failed.'))
      return
    }
    pending.resolve(message.result ?? null)
  }

  private handleWorkerFailure(error: Error) {
    if (this.closed || this.failure) return
    this.failure = error
    this.outstandingRequestIds.clear()
    this.rejectPendingRequests(error)
  }

  private rejectPendingRequests(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private handleRequestTimeout(id: number) {
    this.rejectPendingRequest(id, new V3TrustedDeviceAccessTimeoutError())
  }

  private rejectPendingRequest(id: number, error: Error) {
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    this.pendingRequests.delete(id)
    clearTimeout(pending.timeout)
    pending.reject(error)
  }
}

function getV3TrustedDeviceAccessWorkerPath() {
  return __filename.endsWith('.ts')
    ? path.resolve(__dirname, '../../dist/transfers/v3TrustedDeviceAccessWorker.js')
    : path.join(__dirname, 'v3TrustedDeviceAccessWorker.js')
}

function isWorkerResponse(value: unknown): value is V3TrustedDeviceAccessWorkerResponse {
  if (!isRecord(value) || typeof value.id !== 'number') return false
  if ('error' in value && value.error !== undefined && typeof value.error !== 'string') return false
  if (!('result' in value) || value.result === undefined || value.result === null) return true
  return isAccessRecord(value.result)
}

function isAccessRecord(value: unknown): value is V3TrustedDeviceAccessRecord {
  return isRecord(value)
    && typeof value.receiveEnabled === 'boolean'
    && (typeof value.transferSecret === 'string' || value.transferSecret === null)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('V3 trusted-device access worker failed.')
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`V3 trusted-device access ${label} must be a positive safe integer.`)
  }
  return value
}
