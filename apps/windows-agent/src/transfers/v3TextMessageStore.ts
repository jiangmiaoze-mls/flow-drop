import os from 'node:os'
import path from 'node:path'
import {Worker} from 'node:worker_threads'

import {V3TransportError} from './v3TransportError'
import {V3_TEXT_MESSAGE_PAGE_LIMIT, type V3TextMessage, type V3TextMessagePage} from './v3TextMessageTypes'

type RequestPayload =
  | {message: Omit<V3TextMessage, 'contentBytes' | 'createdAt' | 'sequence'>; type: 'append'}
  | {after: number; limit: number; recipientDeviceId: string; type: 'listForRecipient'}
  | {agentDeviceId: string; limit: number; peerDeviceId: string; type: 'listConversation'}
  | {type: 'close'}

type WorkerRequest = {id: number; payload: RequestPayload}
type WorkerResponse = {error?: {code?: string; message: string; statusCode?: number}; id: number; result?: unknown}
type PendingRequest = {reject: (error: Error) => void; resolve: (value: unknown) => void}

export class V3TextMessageStore {
  private closed = false
  private failure: Error | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly ready: Promise<void>
  private rejectReady!: (error: Error) => void
  private resolveReady!: () => void
  private readonly worker: Worker

  constructor(rootDirectory = getV3TextMessageRoot()) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.ready.catch(() => undefined)
    this.worker = new Worker(workerPath(), {workerData: {rootDirectory}})
    this.worker.on('message', (message: unknown) => this.onMessage(message))
    this.worker.on('error', (error) => this.fail(toError(error)))
    this.worker.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`V3 text message worker stopped with exit code ${code}.`))
    })
  }

  append(message: Omit<V3TextMessage, 'contentBytes' | 'createdAt' | 'sequence'>): Promise<V3TextMessage> {
    return this.request({message, type: 'append'})
  }

  listConversation(agentDeviceId: string, peerDeviceId: string, limit = V3_TEXT_MESSAGE_PAGE_LIMIT): Promise<V3TextMessage[]> {
    return this.request({agentDeviceId, limit, peerDeviceId, type: 'listConversation'})
  }

  listForRecipient(recipientDeviceId: string, after: number, limit: number): Promise<V3TextMessagePage> {
    return this.request({after, limit, recipientDeviceId, type: 'listForRecipient'})
  }

  async close() {
    if (this.closed) return
    this.closed = true
    try {
      await this.request({type: 'close'}, true)
    } catch {
      // A failed worker cannot service its close request.
    } finally {
      this.rejectAll(new Error('V3 text message worker is closed.'))
      await this.worker.terminate()
    }
  }

  private async request<T>(payload: RequestPayload, allowClosed = false): Promise<T> {
    await this.ready
    if (this.failure) throw this.failure
    if (this.closed && !allowClosed) throw new Error('V3 text message worker is closed.')
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {reject, resolve: resolve as (value: unknown) => void})
      this.worker.postMessage({id, payload} satisfies WorkerRequest)
    })
  }

  private onMessage(message: unknown) {
    if (isRecord(message) && message.type === 'ready') {
      this.resolveReady()
      return
    }
    if (!isRecord(message) || typeof message.id !== 'number') return
    const response = message as WorkerResponse
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    if (response.error) {
      pending.reject(
        typeof response.error.code === 'string' && typeof response.error.statusCode === 'number'
          ? new V3TransportError(response.error.code, response.error.statusCode)
          : new Error(response.error.message)
      )
      return
    }
    pending.resolve(response.result)
  }

  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    this.rejectReady(error)
    this.rejectAll(error)
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export function getV3TextMessageRoot() {
  const configuredRoot = process.env.FLOWDROP_TRANSFER_ROOT
  if (configuredRoot) return configuredRoot
  const dataDirectory = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(dataDirectory, 'FlowDrop', 'transfers')
}

function workerPath() {
  return __filename.endsWith('.ts')
    ? path.resolve(__dirname, '../../dist/transfers/v3TextMessageDatabaseWorker.js')
    : path.join(__dirname, 'v3TextMessageDatabaseWorker.js')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('V3 text message worker failed.')
}
