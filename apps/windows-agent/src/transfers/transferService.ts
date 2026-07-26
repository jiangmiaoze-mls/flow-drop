import {createHash} from 'node:crypto'

import type {CreateTransferRequest, TransferStatusResponse, TransferTask} from '@flowdrop/types'

import type {TrustedDeviceStore} from '../storage/trustedDeviceStore'
import {LEGACY_CHUNK_BYTES, MAX_CHUNK_BYTES, TransferStore} from './transferStore'


const MAX_ITEMS_PER_TRANSFER = 32
const MAX_TEXT_BYTES = 256 * 1024

export class TransferServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code)
    this.name = 'TransferServiceError'
  }
}

export class TransferService {
  constructor(
    private readonly trustedDeviceStore: TrustedDeviceStore,
    private readonly transferStore = new TransferStore()
  ) {}

  close() {
    this.transferStore.close()
  }

  listIncomingTransfers(): TransferTask[] {
    return this.transferStore.list()
  }

  createIncomingTransfer(request: CreateTransferRequest): TransferStatusResponse {
    validateCreateTransferRequest(request)
    this.assertReceivePermission(request.sourceDeviceId)
    const existingSourceDeviceId = this.transferStore.getSourceDeviceId(request.transferId)
    if (existingSourceDeviceId && existingSourceDeviceId !== request.sourceDeviceId) {
      throw new TransferServiceError('TRANSFER_ID_CONFLICT', 409)
    }

    return {
      task: this.transferStore.createIncomingTransfer({
        chunkSizeBytes: request.chunkSizeBytes ?? LEGACY_CHUNK_BYTES,
        items: request.items,
        sourceDeviceId: request.sourceDeviceId,
        transferId: request.transferId
      })
    }
  }

  getIncomingTransfer(transferId: string, sourceDeviceId: string): TransferStatusResponse {
    this.assertTransferSource(transferId, sourceDeviceId)
    return {task: this.requireTask(transferId)}
  }

  uploadChunk(
    transferId: string,
    itemId: string,
    chunkIndex: number,
    sourceDeviceId: string,
    contentRange: ContentRange,
    data: Buffer,
    expectedChunkSha256: string
  ): TransferStatusResponse {
    this.assertTransferSource(transferId, sourceDeviceId)
    this.assertReceivePermission(sourceDeviceId)
    const transfer = this.requireTask(transferId)
    this.assertTransferWritable(transfer)
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || data.length === 0 || data.length > transfer.chunkSizeBytes) {
      throw new TransferServiceError('INVALID_CHUNK', 400)
    }
    if (contentRange.start !== chunkIndex * transfer.chunkSizeBytes || contentRange.end - contentRange.start + 1 !== data.length) {
      throw new TransferServiceError('INVALID_CONTENT_RANGE', 400)
    }
    const item = transfer.items.find((candidate) => candidate.itemId === itemId)
    if (!item || item.kind !== 'file' || contentRange.total !== item.sizeBytes || contentRange.end >= item.sizeBytes) {
      throw new TransferServiceError('INVALID_CONTENT_RANGE', 400)
    }
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest !== expectedChunkSha256.toLowerCase()) {
      throw new TransferServiceError('CHUNK_HASH_MISMATCH', 422)
    }
    const task = this.transferStore.writeChunk(transferId, itemId, {
      bytes: data.length,
      chunkIndex,
      sha256: digest
    }, data)
    return {task}
  }

  async completeIncomingTransfer(transferId: string, sourceDeviceId: string): Promise<TransferStatusResponse> {
    this.assertTransferSource(transferId, sourceDeviceId)
    this.assertReceivePermission(sourceDeviceId)
    this.assertTransferWritable(this.requireTask(transferId))
    return {task: await this.transferStore.complete(transferId)}
  }

  cancelIncomingTransfer(transferId: string, sourceDeviceId: string): TransferStatusResponse {
    this.assertTransferSource(transferId, sourceDeviceId)
    if (this.requireTask(transferId).status === 'completed') {
      throw new TransferServiceError('TRANSFER_NOT_CANCELLABLE', 409)
    }
    return {task: this.transferStore.cancel(transferId)}
  }

  pauseIncomingTransfer(transferId: string, sourceDeviceId: string): TransferStatusResponse {
    this.assertTransferSource(transferId, sourceDeviceId)
    const task = this.requireTask(transferId)
    if (isTerminalTransferStatus(task.status)) throw new TransferServiceError('TRANSFER_NOT_PAUSABLE', 409)
    return {task: this.transferStore.pause(transferId)}
  }

  resumeIncomingTransfer(transferId: string, sourceDeviceId: string): TransferStatusResponse {
    this.assertTransferSource(transferId, sourceDeviceId)
    this.assertReceivePermission(sourceDeviceId)
    const task = this.requireTask(transferId)
    if (isTerminalTransferStatus(task.status)) throw new TransferServiceError('TRANSFER_NOT_RESUMABLE', 409)
    return {task: this.transferStore.resume(transferId)}
  }

  private assertReceivePermission(sourceDeviceId: string) {
    const device = this.trustedDeviceStore.get(sourceDeviceId)
    if (!device) throw new TransferServiceError('DEVICE_NOT_PAIRED', 403)
    if (!device.receiveEnabled) throw new TransferServiceError('TRANSFER_RECEIVE_DISABLED', 403)
  }

  private assertTransferSource(transferId: string, sourceDeviceId: string) {
    const actualSourceDeviceId = this.transferStore.getSourceDeviceId(transferId)
    if (!actualSourceDeviceId) throw new TransferServiceError('TRANSFER_NOT_FOUND', 404)
    if (actualSourceDeviceId !== sourceDeviceId) throw new TransferServiceError('TRANSFER_FORBIDDEN', 403)
  }

  private requireTask(transferId: string): TransferTask {
    const task = this.transferStore.get(transferId)
    if (!task) throw new TransferServiceError('TRANSFER_NOT_FOUND', 404)
    return task
  }

  private assertTransferWritable(task: TransferTask) {
    if (task.status === 'paused') throw new TransferServiceError('TRANSFER_PAUSED', 409)
    if (isTerminalTransferStatus(task.status)) throw new TransferServiceError('TRANSFER_NOT_WRITABLE', 409)
  }
}

function isTerminalTransferStatus(status: TransferTask['status']) {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

export type ContentRange = {end: number; start: number; total: number}

export function parseContentRange(value: unknown): ContentRange | null {
  if (typeof value !== 'string') return null
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total) && start >= 0 && end >= start && total > end
    ? {end, start, total}
    : null
}

function validateCreateTransferRequest(value: CreateTransferRequest) {
  if (value.v !== 1 || !isIdentifier(value.transferId) || !isIdentifier(value.sourceDeviceId)) {
    throw new TransferServiceError('INVALID_TRANSFER', 400)
  }
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_ITEMS_PER_TRANSFER) {
    throw new TransferServiceError('INVALID_TRANSFER_ITEMS', 400)
  }
  if (value.chunkSizeBytes !== undefined && (!Number.isInteger(value.chunkSizeBytes) || value.chunkSizeBytes < LEGACY_CHUNK_BYTES || value.chunkSizeBytes > MAX_CHUNK_BYTES)) {
    throw new TransferServiceError('INVALID_TRANSFER_CHUNK_SIZE', 400)
  }
  const itemIds = new Set<string>()
  for (const item of value.items) {
    if (!isIdentifier(item.itemId) || itemIds.has(item.itemId) || !isFileName(item.name) || !isMimeType(item.mimeType) || !isSha256(item.sha256) || !isSize(item.sizeBytes)) {
      throw new TransferServiceError('INVALID_TRANSFER_ITEM', 400)
    }
    itemIds.add(item.itemId)
    if (item.kind === 'text') {
      if (typeof item.text !== 'string' || Buffer.byteLength(item.text, 'utf8') > MAX_TEXT_BYTES) {
        throw new TransferServiceError('INVALID_TEXT_ITEM', 400)
      }
      continue
    }
    if (item.kind !== 'file' || item.text !== undefined) throw new TransferServiceError('INVALID_FILE_ITEM', 400)
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isFileName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 255 && !/[\\/\u0000]/.test(value)
}

function isMimeType(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}
