import {createHash, randomUUID} from 'node:crypto'
import {copyFile, mkdir, open, readFile, rename, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {calculateV3ContentRootFromHexDigests, getV3ContentRootChunkCount, getV3ContentRootChunkLength} from './v3ContentRoot'
import {V3TransportError} from './v3TransportError'
import {
  type V3OutgoingTransferChunk,
  type V3OutgoingTransferCreation,
  type V3OutgoingTransferItem,
  type V3OutgoingTransferOffer,
  type V3OutgoingTransferSourceItem,
  type V3OutgoingTransferStatus,
  type V3OutgoingTransferStatusResponse
} from './v3OutgoingTransferTypes'
import {V3_DEFAULT_CHUNK_BYTES, V3_MAX_CHUNK_BYTES, V3_MIN_CHUNK_BYTES} from './v3TransportTypes'

type StoredItem = V3OutgoingTransferItem & {
  acknowledgedChunks: Record<string, {sha256: string; sizeBytes: number}>
  sourcePath: string
}

type StoredTransfer = {
  chunkSizeBytes: number
  items: StoredItem[]
  recipientDeviceId: string
  revision: number
  status: V3OutgoingTransferStatus
  transferId: string
}

type PersistedStore = {transfers: StoredTransfer[]; version: 1}

const TRANSFER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/

/**
 * Persistent Agent-to-mobile source catalogue. The copied source file is
 * immutable from the protocol's point of view: its advertised hashes are
 * calculated before the offer can be emitted, and bytes are never served from
 * the caller-owned original path.
 */
export class V3OutgoingTransferService {
  private readonly ready: Promise<void>
  private readonly records = new Map<string, StoredTransfer>()
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly rootDirectory = path.join(process.env.LOCALAPPDATA || os.homedir(), 'FlowDrop', 'outgoing-v3')
  ) {
    this.ready = this.load()
  }

  async create(input: V3OutgoingTransferCreation): Promise<V3OutgoingTransferOffer> {
    await this.ready
    const recipientDeviceId = assertIdentifier(input.recipientDeviceId, 'recipient device ID')
    const transferId = input.transferId === undefined ? randomUUID() : assertIdentifier(input.transferId, 'transfer ID')
    const chunkSizeBytes = assertChunkSize(input.chunkSizeBytes ?? V3_DEFAULT_CHUNK_BYTES)
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 32) {
      throw new V3TransportError('INVALID_OUTGOING_TRANSFER', 400)
    }
    if (this.records.has(transferId)) {
      const existing = this.records.get(transferId)!
      if (existing.recipientDeviceId !== recipientDeviceId) throw new V3TransportError('TRANSFER_FORBIDDEN', 403)
      return toOffer(existing)
    }

    const itemIds = new Set<string>()
    const items: StoredItem[] = []
    for (const [index, source] of input.items.entries()) {
      const itemId = assertIdentifier(source.itemId, 'item ID')
      if (itemIds.has(itemId)) throw new V3TransportError('INVALID_OUTGOING_TRANSFER', 400)
      itemIds.add(itemId)
      items.push(await this.snapshotItem(transferId, index, source, chunkSizeBytes))
    }

    const record: StoredTransfer = {
      chunkSizeBytes,
      items,
      recipientDeviceId,
      revision: 1,
      status: areAllChunksAcknowledged(items, chunkSizeBytes) ? 'completed' : 'waiting_for_peer',
      transferId
    }
    this.records.set(transferId, record)
    await this.persist()
    return toOffer(record)
  }

  async getStatus(transferId: string, recipientDeviceId: string): Promise<V3OutgoingTransferStatusResponse> {
    const record = await this.getForRecipient(transferId, recipientDeviceId)
    return toStatus(record)
  }

  /** Administrative projection excludes source paths and transfer credentials. */
  async listForAdmin(): Promise<V3OutgoingTransferStatusResponse[]> {
    await this.ready
    return [...this.records.values()]
      .map(toStatus)
      .sort((left, right) => right.revision - left.revision || right.transferId.localeCompare(left.transferId))
  }

  async getOffers(recipientDeviceId: string): Promise<V3OutgoingTransferOffer[]> {
    await this.ready
    return [...this.records.values()]
      .filter((record) => record.recipientDeviceId === recipientDeviceId && isOfferable(record))
      .map(toOffer)
  }

  async markOfferDelivered(transferId: string, recipientDeviceId: string): Promise<V3OutgoingTransferOffer> {
    const record = await this.getForRecipient(transferId, recipientDeviceId)
    if (record.status === 'waiting_for_peer') {
      record.status = 'transferring'
      record.revision += 1
      await this.persist()
    }
    return toOffer(record)
  }

  async readChunk(
    transferId: string,
    itemId: string,
    chunkIndex: number,
    recipientDeviceId: string
  ): Promise<V3OutgoingTransferChunk> {
    const record = await this.getForRecipient(transferId, recipientDeviceId)
    if (record.status === 'paused') throw new V3TransportError('TRANSFER_PAUSED', 409)
    if (!isTransferReadable(record.status)) throw new V3TransportError('TRANSFER_CLOSING', 409)
    const item = findItem(record, itemId)
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new V3TransportError('INVALID_CHUNK', 400)
    const count = getV3ContentRootChunkCount(item.sizeBytes, record.chunkSizeBytes)
    if (chunkIndex >= count) throw new V3TransportError('INVALID_CHUNK', 400)
    const size = getV3ContentRootChunkLength(item.sizeBytes, record.chunkSizeBytes, chunkIndex)
    const start = chunkIndex * record.chunkSizeBytes
    const handle = await open(item.sourcePath, 'r')
    try {
      const data = Buffer.allocUnsafe(size)
      const {bytesRead} = await handle.read(data, 0, size, start)
      if (bytesRead !== size) throw new V3TransportError('OUTGOING_SOURCE_UNAVAILABLE', 409)
      return {
        data,
        end: start + size - 1,
        sha256: createHash('sha256').update(data).digest('hex'),
        start,
        total: item.sizeBytes
      }
    } finally {
      await handle.close()
    }
  }

  async acknowledgeChunk(
    transferId: string,
    itemId: string,
    chunkIndex: number,
    recipientDeviceId: string,
    sha256: string,
    sizeBytes: number
  ): Promise<V3OutgoingTransferStatusResponse> {
    const record = await this.getForRecipient(transferId, recipientDeviceId)
    if (!isTransferAcknowledgable(record.status)) throw new V3TransportError('TRANSFER_CLOSING', 409)
    const item = findItem(record, itemId)
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !SHA256.test(sha256) || !Number.isSafeInteger(sizeBytes)) {
      throw new V3TransportError('INVALID_CHUNK_ACK', 400)
    }
    const count = getV3ContentRootChunkCount(item.sizeBytes, record.chunkSizeBytes)
    if (chunkIndex >= count || sizeBytes !== getV3ContentRootChunkLength(item.sizeBytes, record.chunkSizeBytes, chunkIndex)) {
      throw new V3TransportError('INVALID_CHUNK_ACK', 400)
    }
    const expected = await this.readChunk(transferId, itemId, chunkIndex, recipientDeviceId)
    if (expected.sha256 !== sha256) throw new V3TransportError('CHUNK_HASH_MISMATCH', 422)
    const current = item.acknowledgedChunks[String(chunkIndex)]
    if (current && (current.sha256 !== sha256 || current.sizeBytes !== sizeBytes)) {
      throw new V3TransportError('CHUNK_ACK_CONFLICT', 409)
    }
    if (!current) {
      item.acknowledgedChunks[String(chunkIndex)] = {sha256, sizeBytes}
      record.revision += 1
      if (allChunksAcknowledged(record)) record.status = 'completed'
      await this.persist()
    }
    return toStatus(record)
  }

  async pause(transferId: string, recipientDeviceId: string): Promise<V3OutgoingTransferStatusResponse> {
    return this.setControlState(transferId, recipientDeviceId, 'pause')
  }

  async resume(transferId: string, recipientDeviceId: string): Promise<V3OutgoingTransferStatusResponse> {
    return this.setControlState(transferId, recipientDeviceId, 'resume')
  }

  async cancel(transferId: string, recipientDeviceId: string): Promise<V3OutgoingTransferStatusResponse> {
    return this.setControlState(transferId, recipientDeviceId, 'cancel')
  }

  private async setControlState(
    transferId: string,
    recipientDeviceId: string,
    operation: 'cancel' | 'pause' | 'resume'
  ): Promise<V3OutgoingTransferStatusResponse> {
    const record = await this.getForRecipient(transferId, recipientDeviceId)
    const next = operation === 'pause' ? 'paused' : operation === 'resume' ? 'transferring' : 'cancelled'
    if (record.status === next) return toStatus(record)
    if (
      record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled'
      || (operation === 'resume' && record.status !== 'paused')
      || (operation === 'pause' && !isTransferAcknowledgable(record.status))
    ) throw new V3TransportError('TRANSFER_STATE_INVALID', 409)
    record.status = next
    record.revision += 1
    await this.persist()
    return toStatus(record)
  }

  private async snapshotItem(
    transferId: string,
    itemIndex: number,
    source: V3OutgoingTransferSourceItem,
    chunkSizeBytes: number
  ): Promise<StoredItem> {
    const itemId = assertIdentifier(source.itemId, 'item ID')
    if (typeof source.name !== 'string' || source.name.length === 0 || source.name.length > 255 || typeof source.mimeType !== 'string' || source.mimeType.length > 255) {
      throw new V3TransportError('INVALID_OUTGOING_TRANSFER', 400)
    }
    const sourceInfo = await stat(source.sourcePath).catch(() => null)
    if (!sourceInfo?.isFile() || !Number.isSafeInteger(sourceInfo.size) || sourceInfo.size < 0) {
      throw new V3TransportError('OUTGOING_SOURCE_UNAVAILABLE', 409)
    }
    const relativePath = path.join(transferId, `${itemIndex}-${itemId}.source`)
    const snapshotPath = path.join(this.rootDirectory, 'sources', relativePath)
    await mkdir(path.dirname(snapshotPath), {recursive: true})
    await copyFile(source.sourcePath, snapshotPath, 0)
    const chunks = await hashFile(snapshotPath, sourceInfo.size, chunkSizeBytes)
    return {
      acknowledgedChunks: {},
      contentRoot: calculateV3ContentRootFromHexDigests({chunkSizeBytes, chunks, fileSizeBytes: sourceInfo.size}),
      itemId,
      mimeType: source.mimeType,
      name: source.name,
      sizeBytes: sourceInfo.size,
      sourcePath: snapshotPath
    }
  }

  private async getForRecipient(transferId: string, recipientDeviceId: string): Promise<StoredTransfer> {
    await this.ready
    const record = this.records.get(transferId)
    if (!record) throw new V3TransportError('TRANSFER_NOT_FOUND', 404)
    if (record.recipientDeviceId !== recipientDeviceId) throw new V3TransportError('TRANSFER_FORBIDDEN', 403)
    return record
  }

  private async load() {
    await mkdir(path.join(this.rootDirectory, 'sources'), {recursive: true})
    const persisted = await readFile(this.storePath, 'utf8')
      .then((value) => JSON.parse(value) as unknown)
      .catch(() => ({transfers: [], version: 1}))
    if (!isPersistedStore(persisted)) return
    let repaired = false
    for (const transfer of persisted.transfers) {
      if (!isStoredTransfer(transfer)) continue
      this.records.set(transfer.transferId, transfer)
      const unavailable = await Promise.all(transfer.items.map(async (item) => !(await stat(item.sourcePath).catch(() => null))?.isFile()))
      if (unavailable.some(Boolean) && isOutstanding(transfer.status)) {
        transfer.status = 'failed'
        transfer.revision += 1
        repaired = true
      }
    }
    if (repaired) await this.persist()
  }

  private persist(): Promise<void> {
    const write = this.writeTail.then(async () => {
      const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
      const value: PersistedStore = {transfers: [...this.records.values()], version: 1}
      await writeFile(temporaryPath, JSON.stringify(value), 'utf8')
      await rename(temporaryPath, this.storePath)
    })
    this.writeTail = write.catch(() => undefined)
    return write
  }

  private get storePath() {
    return path.join(this.rootDirectory, 'outgoing-transfers.json')
  }
}

function toOffer(record: StoredTransfer): V3OutgoingTransferOffer {
  return {
    chunkSizeBytes: record.chunkSizeBytes,
    items: record.items.map(({contentRoot, itemId, mimeType, name, sizeBytes}) => ({contentRoot, itemId, mimeType, name, sizeBytes})),
    revision: record.revision,
    transferId: record.transferId
  }
}

function toStatus(record: StoredTransfer): V3OutgoingTransferStatusResponse {
  return {
    ...toOffer(record),
    acknowledgedRanges: Object.fromEntries(record.items.map((item) => [item.itemId, acknowledgedRanges(item, record.chunkSizeBytes)])),
    status: record.status
  }
}

function acknowledgedRanges(item: StoredItem, chunkSizeBytes: number): Array<[start: number, end: number]> {
  const indexes = Object.keys(item.acknowledgedChunks).map(Number).sort((left, right) => left - right)
  return indexes.map((index) => {
    const acknowledgement = item.acknowledgedChunks[String(index)]!
    const start = index * chunkSizeBytes
    return [start, start + acknowledgement.sizeBytes - 1]
  })
}

function findItem(record: StoredTransfer, itemId: string): StoredItem {
  const item = record.items.find((candidate) => candidate.itemId === itemId)
  if (!item) throw new V3TransportError('TRANSFER_ITEM_NOT_FOUND', 404)
  return item
}

function allChunksAcknowledged(record: StoredTransfer): boolean {
  return areAllChunksAcknowledged(record.items, record.chunkSizeBytes)
}

function areAllChunksAcknowledged(items: StoredItem[], chunkSizeBytes: number): boolean {
  return items.every((item) => Object.keys(item.acknowledgedChunks).length === getV3ContentRootChunkCount(item.sizeBytes, chunkSizeBytes))
}

function isOutstanding(status: V3OutgoingTransferStatus) {
  return status === 'waiting_for_peer' || status === 'preparing' || status === 'transferring' || status === 'paused'
}

function isOfferable(record: StoredTransfer) {
  // Zero-byte files have no chunk ACK to advance the Agent state. They are
  // already complete when created, but must still be offered after reconnect.
  return isOutstanding(record.status) || (record.status === 'completed' && record.items.every((item) => item.sizeBytes === 0))
}

function isTransferReadable(status: V3OutgoingTransferStatus) {
  return status === 'waiting_for_peer' || status === 'preparing' || status === 'transferring'
}

function isTransferAcknowledgable(status: V3OutgoingTransferStatus) {
  return status === 'waiting_for_peer' || status === 'preparing' || status === 'transferring'
}

function assertChunkSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < V3_MIN_CHUNK_BYTES || value > V3_MAX_CHUNK_BYTES) {
    throw new V3TransportError('INVALID_OUTGOING_TRANSFER', 400)
  }
  return value
}

function assertIdentifier(value: unknown, _label: string): string {
  if (typeof value !== 'string' || !TRANSFER_ID.test(value)) throw new V3TransportError('INVALID_OUTGOING_TRANSFER', 400)
  return value
}

function isPersistedStore(value: unknown): value is PersistedStore {
  return Boolean(value && typeof value === 'object' && (value as {version?: unknown}).version === 1 && Array.isArray((value as {transfers?: unknown}).transfers))
}

function isStoredTransfer(value: unknown): value is StoredTransfer {
  if (!value || typeof value !== 'object') return false
  const transfer = value as Partial<StoredTransfer>
  return typeof transfer.transferId === 'string'
    && typeof transfer.recipientDeviceId === 'string'
    && typeof transfer.chunkSizeBytes === 'number'
    && typeof transfer.revision === 'number'
    && typeof transfer.status === 'string'
    && Array.isArray(transfer.items)
    && transfer.items.every((item) => isStoredItem(item))
}

function isStoredItem(value: unknown): value is StoredItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<StoredItem>
  return typeof item.itemId === 'string'
    && typeof item.mimeType === 'string'
    && typeof item.name === 'string'
    && typeof item.sizeBytes === 'number'
    && typeof item.contentRoot === 'string'
    && typeof item.sourcePath === 'string'
    && Boolean(item.acknowledgedChunks && typeof item.acknowledgedChunks === 'object')
}

async function hashFile(sourcePath: string, sizeBytes: number, chunkSizeBytes: number) {
  const handle = await open(sourcePath, 'r')
  try {
    const chunks: Array<{index: number; length: number; sha256: string}> = []
    const count = getV3ContentRootChunkCount(sizeBytes, chunkSizeBytes)
    for (let index = 0; index < count; index += 1) {
      const length = getV3ContentRootChunkLength(sizeBytes, chunkSizeBytes, index)
      const data = Buffer.allocUnsafe(length)
      const {bytesRead} = await handle.read(data, 0, length, index * chunkSizeBytes)
      if (bytesRead !== length) throw new V3TransportError('OUTGOING_SOURCE_UNAVAILABLE', 409)
      chunks.push({index, length, sha256: createHash('sha256').update(data).digest('hex')})
    }
    return chunks
  } finally {
    await handle.close()
  }
}
