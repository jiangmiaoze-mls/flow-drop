import * as Crypto from 'expo-crypto'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {File, FileMode} from 'expo-file-system'
import {addSha256ProgressListener, sha256FileAsync} from '@flowdrop/network/mobile'

import type {CreateTransferRequest, TransferFailureCode, TransferStatusResponse} from '@flowdrop/types'
import type {OutgoingTransferTask} from '@/storage/outgoingTransferRepository'


export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_IN_FLIGHT_CHUNKS = 4
const MAX_TEXT_BYTES = 256 * 1024
const FILE_PROCESSING_CHUNK_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 15_000

export class TransferClientError extends Error {
  constructor(
    public readonly code: TransferFailureCode
      | 'TRANSFER_CANCELLED'
      | 'TRANSFER_ENDPOINT_UNAVAILABLE'
      | 'TRANSFER_NOT_FOUND'
      | 'TRANSFER_NOT_PAUSABLE'
      | 'TRANSFER_NOT_RESUMABLE'
      | 'TRANSFER_PAUSED'
      | 'TRANSFER_PROTOCOL_ERROR'
  ) {
    super(code)
    this.name = 'TransferClientError'
  }
}

export function hashText(text: string): {sha256: string; sizeBytes: number} {
  const bytes = utf8ToBytes(text)
  if (bytes.length > MAX_TEXT_BYTES) throw new TransferClientError('INVALID_TRANSFER')
  return {sha256: bytesToHex(sha256(bytes)), sizeBytes: bytes.length}
}

export async function hashFile(
  file: File,
  onProgress?: (processedBytes: number, totalBytes: number) => void
): Promise<{sha256: string; sizeBytes: number}> {
  if (!file.exists) throw new TransferClientError('FILE_CHANGED')
  const sizeBytes = file.size
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new TransferClientError('FILE_CHANGED')

  const operationId = Crypto.randomUUID()
  const subscription = onProgress
    ? addSha256ProgressListener((event) => {
      if (event.operationId !== operationId) return
      onProgress(event.processedBytes, event.totalBytes)
    })
    : null
  try {
    const nativeHash = await sha256FileAsync(file.uri, operationId)
    if (nativeHash) {
      if (nativeHash.sizeBytes !== sizeBytes) throw new TransferClientError('FILE_CHANGED')
      onProgress?.(nativeHash.sizeBytes, nativeHash.sizeBytes)
      return nativeHash
    }
  } finally {
    subscription?.remove()
  }

  const digest = sha256.create()
  const handle = file.open(FileMode.ReadOnly)
  try {
    for (let processedBytes = 0; processedBytes < sizeBytes;) {
      const remaining = sizeBytes - processedBytes
      const bytes = handle.readBytes(Math.min(FILE_PROCESSING_CHUNK_BYTES, remaining))
      if (bytes.length === 0) throw new TransferClientError('FILE_CHANGED')
      digest.update(bytes)
      processedBytes += bytes.length
      onProgress?.(processedBytes, sizeBytes)
      await yieldToUi()
    }
  } finally {
    handle.close()
  }
  return {sha256: bytesToHex(digest.digest()), sizeBytes}
}

export async function sendOutgoingTransfer(
  task: OutgoingTransferTask,
  sourceDeviceId: string,
  transferSecret: string,
  onProgress: (transferredBytes: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const baseUrl = `http://${task.peerAddress}:${task.peerControlPort}`
  const createRequest: CreateTransferRequest = {
    chunkSizeBytes: TRANSFER_CHUNK_BYTES,
    items: task.items.map(({itemId, kind, mimeType, name, sha256: itemSha256, sizeBytes, text}) => ({
      itemId,
      kind,
      mimeType,
      name,
      sha256: itemSha256,
      sizeBytes,
      text
    })),
    sourceDeviceId,
    transferId: task.transferId,
    v: 1
  }
  throwIfAborted(signal)
  const createResponse = await requestJson(`${baseUrl}/v1/transfers`, signRequest('POST', '/v1/transfers', sourceDeviceId, transferSecret, {
    body: JSON.stringify(createRequest),
    headers: {'content-type': 'application/json'},
    method: 'POST',
    signal
  }), 201)

  if (createResponse.task.status === 'completed') {
    onProgress(task.totalBytes)
    return
  }
  if (createResponse.task.status === 'paused') throw new TransferClientError('TRANSFER_PAUSED')

  const chunkSizeBytes = createResponse.task.chunkSizeBytes
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0 || chunkSizeBytes > TRANSFER_CHUNK_BYTES) {
    throw new TransferClientError('TRANSFER_PROTOCOL_ERROR')
  }
  const receivedBytesByItemId = new Map(createResponse.task.items.map((item) => [item.itemId, item.receivedBytes]))
  const receivedChunkIndexesByItemId = new Map(createResponse.task.items.map((item) => [item.itemId, new Set(item.receivedChunkIndexes)]))
  let transferredBytes = 0
  for (const item of task.items) {
    throwIfAborted(signal)
    const receivedBytes = receivedBytesByItemId.get(item.itemId)
    if (receivedBytes === undefined || receivedBytes < 0 || receivedBytes > item.sizeBytes) {
      throw new TransferClientError('TRANSFER_PROTOCOL_ERROR')
    }
    transferredBytes += receivedBytes
    if (item.kind !== 'file') {
      continue
    }
    if (!item.sourceUri) throw new TransferClientError('FILE_CHANGED')
    const file = new File(item.sourceUri)
    if (!file.exists || file.size !== item.sizeBytes) {
      throw new TransferClientError('FILE_CHANGED')
    }

    const handle = file.open(FileMode.ReadOnly)
    try {
      const receivedChunkIndexes = receivedChunkIndexesByItemId.get(item.itemId)
      if (!receivedChunkIndexes) throw new TransferClientError('TRANSFER_PROTOCOL_ERROR')
      const totalChunkCount = Math.ceil(item.sizeBytes / chunkSizeBytes)
      if ([...receivedChunkIndexes].some((chunkIndex) => !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunkCount)) {
        throw new TransferClientError('TRANSFER_PROTOCOL_ERROR')
      }
      await uploadFileChunks({
        baseUrl,
        chunkSizeBytes,
        fileHandle: handle,
        item,
        onChunkConfirmed: (bytes) => {
          transferredBytes += bytes
          onProgress(transferredBytes)
        },
        receivedChunkIndexes,
        signal,
        sourceDeviceId,
        task,
        transferSecret
      })
    } finally {
      handle.close()
    }
  }
  onProgress(transferredBytes)
  throwIfAborted(signal)
  await requestJson(`${baseUrl}/v1/transfers/${task.transferId}/complete`, signRequest('POST', `/v1/transfers/${task.transferId}/complete`, sourceDeviceId, transferSecret, {
    headers: {'x-flowdrop-source-device-id': sourceDeviceId},
    method: 'POST',
    signal
  }))
}

export async function cancelOutgoingTransfer(
  task: OutgoingTransferTask,
  sourceDeviceId: string,
  transferSecret: string
): Promise<TransferStatusResponse> {
  return changeOutgoingTransferState(task, sourceDeviceId, transferSecret, 'cancel')
}

export async function pauseOutgoingTransfer(
  task: OutgoingTransferTask,
  sourceDeviceId: string,
  transferSecret: string
): Promise<TransferStatusResponse> {
  return changeOutgoingTransferState(task, sourceDeviceId, transferSecret, 'pause')
}

export async function resumeOutgoingTransfer(
  task: OutgoingTransferTask,
  sourceDeviceId: string,
  transferSecret: string
): Promise<TransferStatusResponse> {
  return changeOutgoingTransferState(task, sourceDeviceId, transferSecret, 'resume')
}

async function changeOutgoingTransferState(
  task: OutgoingTransferTask,
  sourceDeviceId: string,
  transferSecret: string,
  operation: 'cancel' | 'pause' | 'resume'
): Promise<TransferStatusResponse> {
  const path = `/v1/transfers/${task.transferId}/${operation}`
  const baseUrl = `http://${task.peerAddress}:${task.peerControlPort}`
  return requestJson(`${baseUrl}${path}`, signRequest('POST', path, sourceDeviceId, transferSecret, {
    headers: {'x-flowdrop-source-device-id': sourceDeviceId},
    method: 'POST'
  }))
}

function signRequest(method: string, path: string, sourceDeviceId: string, transferSecret: string, init: RequestInit): RequestInit {
  const timestamp = Date.now().toString()
  const nonce = Crypto.randomUUID()
  const body = init.body instanceof Uint8Array
    ? init.body
    : utf8ToBytes(typeof init.body === 'string' ? init.body : '')
  const bodyHash = bytesToHex(sha256(body))
  const message = utf8ToBytes(`${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`)
  const signature = bytesToHex(hmac(sha256, hexToBytes(transferSecret), message))
  return {
    ...init,
    headers: {
      ...init.headers,
      'x-flowdrop-nonce': nonce,
      'x-flowdrop-signature': signature,
      'x-flowdrop-source-device-id': sourceDeviceId,
      'x-flowdrop-timestamp': timestamp
    }
  }
}

async function requestJson(url: string, init: RequestInit, expectedStatus = 200): Promise<TransferStatusResponse> {
  let response: Response
  try {
    response = await fetchWithTimeout(url, init)
  } catch {
    if (init.signal?.aborted) throw new TransferClientError('TRANSFER_CANCELLED')
    throw new TransferClientError('NETWORK_TIMEOUT')
  }
  const payload = await readPayload(response)
  if (response.status === expectedStatus) return payload as TransferStatusResponse
  if (payload && 'code' in payload && typeof payload.code === 'string') {
    throw new TransferClientError(toKnownFailureCode(payload.code))
  }
  throw new TransferClientError('TRANSFER_ENDPOINT_UNAVAILABLE')
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  init.signal?.addEventListener('abort', abort, {once: true})
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new TransferClientError('NETWORK_TIMEOUT'))
    }, REQUEST_TIMEOUT_MS)
  })
  try {
    // Some native fetch implementations do not promptly reject after abort().
    // The race still releases the queue and lets its persisted state advance.
    return await Promise.race([fetch(url, {...init, signal: controller.signal}), timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
    init.signal?.removeEventListener('abort', abort)
  }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new TransferClientError('TRANSFER_CANCELLED')
}

async function uploadFileChunks(input: {
  baseUrl: string
  chunkSizeBytes: number
  fileHandle: ReturnType<File['open']>
  item: OutgoingTransferTask['items'][number]
  onChunkConfirmed: (bytes: number) => void
  receivedChunkIndexes: Set<number>
  signal: AbortSignal | undefined
  sourceDeviceId: string
  task: OutgoingTransferTask
  transferSecret: string
}) {
  const pending = new Set<Promise<void>>()
  let failure: unknown
  const totalChunkCount = Math.ceil(input.item.sizeBytes / input.chunkSizeBytes)
  for (let chunkIndex = 0; chunkIndex < totalChunkCount; chunkIndex += 1) {
    if (input.receivedChunkIndexes.has(chunkIndex)) continue
    while (pending.size >= MAX_IN_FLIGHT_CHUNKS) {
      await Promise.race(pending)
      if (failure) throw failure
    }
    throwIfAborted(input.signal)
    const offset = chunkIndex * input.chunkSizeBytes
    input.fileHandle.offset = offset
    const bytes = input.fileHandle.readBytes(Math.min(input.chunkSizeBytes, input.item.sizeBytes - offset))
    if (bytes.length === 0) throw new TransferClientError('FILE_CHANGED')
    const end = offset + bytes.length - 1
    let request: Promise<void>
    request = requestJson(
      `${input.baseUrl}/v1/transfers/${input.task.transferId}/items/${input.item.itemId}/chunks/${chunkIndex}`,
      signRequest('PUT', `/v1/transfers/${input.task.transferId}/items/${input.item.itemId}/chunks/${chunkIndex}`, input.sourceDeviceId, input.transferSecret, {
        body: bytes,
        headers: {
          'content-range': `bytes ${offset}-${end}/${input.item.sizeBytes}`,
          'content-type': 'application/octet-stream',
          'x-flowdrop-chunk-sha256': bytesToHex(sha256(bytes)),
          'x-flowdrop-source-device-id': input.sourceDeviceId
        },
        method: 'PUT',
        signal: input.signal
      })
    ).then(() => {
      input.onChunkConfirmed(bytes.length)
    }).catch((error) => {
      failure ??= error
    }).finally(() => {
      pending.delete(request)
    })
    pending.add(request)
  }
  while (pending.size > 0) {
    await Promise.race(pending)
    if (failure) throw failure
  }
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function readPayload(response: Response): Promise<{code?: unknown} | TransferStatusResponse | null> {
  try {
    return await response.json() as {code?: unknown} | TransferStatusResponse
  } catch {
    return null
  }
}

function toKnownFailureCode(value: string): TransferClientError['code'] {
  const codes: TransferClientError['code'][] = [
    'AUTHENTICATION_REQUIRED',
    'DEVICE_NOT_PAIRED',
    'FILE_CHANGED',
    'HASH_MISMATCH',
    'INSUFFICIENT_STORAGE',
    'INVALID_TRANSFER',
    'NETWORK_TIMEOUT',
    'PEER_OFFLINE',
    'PROTOCOL_VERSION_UNSUPPORTED',
    'TRANSFER_RECEIVE_DISABLED',
    'TRANSFER_NOT_FOUND',
    'TRANSFER_NOT_PAUSABLE',
    'TRANSFER_NOT_RESUMABLE',
    'TRANSFER_PAUSED'
  ]
  return codes.includes(value as TransferClientError['code'])
    ? value as TransferClientError['code']
    : 'TRANSFER_PROTOCOL_ERROR'
}
