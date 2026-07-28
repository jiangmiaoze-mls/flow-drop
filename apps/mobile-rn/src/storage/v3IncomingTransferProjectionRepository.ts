import type {NativeIncomingTransferItem, NativeIncomingTransferStartConfig} from '@/network/nativeTransferController'
import {File, Paths} from 'expo-file-system'
import type {SQLiteDatabase} from 'expo-sqlite'
import {withV3TransferProjectionDatabaseAccess} from './v3TransferProjectionRepository'

export type V3IncomingTransferStatus = 'cancelled' | 'completed' | 'failed' | 'paused' | 'transferring'

export type V3IncomingTransferTask = {
  chunkSizeBytes: number
  confirmedBytes: number
  createdAt: number
  failureCode?: string
  items: Array<NativeIncomingTransferItem & {localUri: string}>
  peerAddress: string
  peerControlPort: number
  peerDeviceId: string
  revision: number
  status: V3IncomingTransferStatus
  totalBytes: number
  transferId: string
  updatedAt: number
}

export type CreateV3IncomingTransferInput = Omit<NativeIncomingTransferStartConfig, 'recipientDeviceId' | 'transferSecretHex'> & {
  peerDeviceId: string
}

export type NativeIncomingTransferEvent = {
  confirmedBytes: number
  errorCode?: string
  localUris?: Record<string, string>
  revision: number
  status: V3IncomingTransferStatus
  transferId: string
}

const listeners = new Set<() => void>()
const statuses = new Set<V3IncomingTransferStatus>(['cancelled', 'completed', 'failed', 'paused', 'transferring'])

export async function createV3IncomingTransfer(input: CreateV3IncomingTransferInput): Promise<V3IncomingTransferTask> {
  validateOffer(input)
  const task = await enqueueIncomingWrite(async (database) => {
    const now = Date.now()
    const totalBytes = input.items.reduce((total, item) => total + item.sizeBytes, 0)
    // Realtime delivery is idempotent. Keep these writes on the primary SQLite
    // connection because the SDK 57 exclusive-transaction bridge is rejected
    // by some Android runtimes before it can prepare a statement.
    await database.runAsync(
      `INSERT INTO incoming_transfer_v3_projection (
        transfer_id, peer_device_id, peer_address, peer_control_port, chunk_size_bytes,
        status, total_bytes, remote_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'transferring', ?, ?, ?, ?)
      ON CONFLICT(transfer_id) DO UPDATE SET
        peer_device_id = excluded.peer_device_id, peer_address = excluded.peer_address,
        peer_control_port = excluded.peer_control_port, chunk_size_bytes = excluded.chunk_size_bytes,
        remote_revision = MAX(incoming_transfer_v3_projection.remote_revision, excluded.remote_revision),
        updated_at = excluded.updated_at
      WHERE incoming_transfer_v3_projection.status NOT IN ('completed', 'cancelled')`,
      input.transferId, input.peerDeviceId, input.peerAddress, input.peerControlPort,
      input.chunkSizeBytes, totalBytes, input.revision, now, now
    )
    for (const [ordinal, item] of input.items.entries()) {
      await database.runAsync(
        `INSERT OR IGNORE INTO incoming_transfer_v3_items (
          transfer_id, item_id, item_ordinal, name, mime_type, size_bytes, content_root, local_uri
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.transferId, item.itemId, ordinal, item.name, item.mimeType, item.sizeBytes, item.contentRoot,
        incomingLocalUri(input.transferId, item.itemId, item.name)
      )
    }
    return loadV3IncomingTransfer(database, input.transferId)
  })
  notify()
  return task
}

export async function applyV3IncomingTransferEvent(event: NativeIncomingTransferEvent): Promise<void> {
  if (!statuses.has(event.status) || !Number.isSafeInteger(event.confirmedBytes) || event.confirmedBytes < 0) return
  const changed = await enqueueIncomingWrite(async (database) => {
    const current = await database.getFirstAsync<{remote_revision: number; status: string; total_bytes: number}>(
      'SELECT remote_revision, status, total_bytes FROM incoming_transfer_v3_projection WHERE transfer_id = ?', event.transferId
    )
    if (!current || event.revision < current.remote_revision || (isTerminal(current.status) && event.status !== current.status)) return false
    await database.runAsync(
      `UPDATE incoming_transfer_v3_projection
       SET status = ?, failure_code = ?, confirmed_bytes = ?, remote_revision = ?, updated_at = ?
       WHERE transfer_id = ?`,
      event.status,
      event.status === 'failed' ? event.errorCode ?? 'INCOMING_TRANSFER_FAILED' : null,
      Math.min(current.total_bytes, Math.max(0, event.confirmedBytes)),
      Math.max(current.remote_revision, event.revision), Date.now(), event.transferId
    )
    if (event.localUris) {
      for (const [itemId, localUri] of Object.entries(event.localUris)) {
        if (typeof localUri !== 'string' || !localUri.startsWith('file://')) continue
        await database.runAsync(
          'UPDATE incoming_transfer_v3_items SET local_uri = ? WHERE transfer_id = ? AND item_id = ?',
          localUri, event.transferId, itemId
        )
      }
    }
    return true
  })
  if (changed) notify()
}

export async function listV3IncomingTransfers(): Promise<V3IncomingTransferTask[]> {
  return enqueueIncomingWrite(async (database) => {
    const rows = await database.getAllAsync<IncomingRow>('SELECT * FROM incoming_transfer_v3_projection ORDER BY updated_at DESC')
    return Promise.all(rows.map((row) => hydrate(database, row)))
  })
}

export function subscribeToV3IncomingTransferChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function deleteV3IncomingTransfer(transferId: string): Promise<void> {
  await enqueueIncomingWrite(async (database) => {
    await database.runAsync('DELETE FROM incoming_transfer_v3_items WHERE transfer_id = ?', transferId)
    await database.runAsync('DELETE FROM incoming_transfer_v3_projection WHERE transfer_id = ?', transferId)
  })
  notify()
}

async function requireV3IncomingTransfer(transferId: string): Promise<V3IncomingTransferTask> {
  return enqueueIncomingWrite((database) => loadV3IncomingTransfer(database, transferId))
}

async function loadV3IncomingTransfer(
  database: SQLiteDatabase,
  transferId: string
): Promise<V3IncomingTransferTask> {
  const row = await database.getFirstAsync<IncomingRow>('SELECT * FROM incoming_transfer_v3_projection WHERE transfer_id = ?', transferId)
  if (!row) throw new Error('TRANSFER_NOT_FOUND')
  return hydrate(database, row)
}

type IncomingRow = {
  chunk_size_bytes: number; confirmed_bytes: number; created_at: number; failure_code: string | null
  peer_address: string; peer_control_port: number; peer_device_id: string; remote_revision: number
  status: string; total_bytes: number; transfer_id: string; updated_at: number
}

async function hydrate(database: SQLiteDatabase, row: IncomingRow): Promise<V3IncomingTransferTask> {
  const items = await database.getAllAsync<{
    content_root: string; item_id: string; local_uri: string; mime_type: string; name: string; size_bytes: number
  }>('SELECT item_id, name, mime_type, size_bytes, content_root, local_uri FROM incoming_transfer_v3_items WHERE transfer_id = ? ORDER BY item_ordinal ASC', row.transfer_id)
  return {
    chunkSizeBytes: row.chunk_size_bytes, confirmedBytes: row.confirmed_bytes, createdAt: row.created_at,
    failureCode: row.failure_code ?? undefined,
    items: items.map((item) => ({contentRoot: item.content_root, itemId: item.item_id, localUri: item.local_uri, mimeType: item.mime_type, name: item.name, sizeBytes: item.size_bytes})),
    peerAddress: row.peer_address, peerControlPort: row.peer_control_port, peerDeviceId: row.peer_device_id,
    revision: row.remote_revision, status: asStatus(row.status), totalBytes: row.total_bytes,
    transferId: row.transfer_id, updatedAt: row.updated_at
  }
}

function validateOffer(input: CreateV3IncomingTransferInput) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.transferId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.peerDeviceId)) throw new Error('INVALID_TRANSFER')
  if (!Number.isSafeInteger(input.chunkSizeBytes) || input.chunkSizeBytes < 1024 * 1024 || input.chunkSizeBytes > 4 * 1024 * 1024) throw new Error('INVALID_TRANSFER')
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.items.length < 1 || input.items.length > 32) throw new Error('INVALID_TRANSFER')
}

function asStatus(value: string): V3IncomingTransferStatus {
  return statuses.has(value as V3IncomingTransferStatus) ? value as V3IncomingTransferStatus : 'failed'
}

function isTerminal(value: string) { return value === 'cancelled' || value === 'completed' || value === 'failed' }
function notify() { listeners.forEach((listener) => listener()) }

function incomingLocalUri(transferId: string, itemId: string, name: string): string {
  return new File(Paths.document, 'flowdrop-managed-files', 'incoming', transferId, `${itemId}-${name}`).uri
}

function enqueueIncomingWrite<T>(
  operation: (database: SQLiteDatabase) => Promise<T>
): Promise<T> {
  return withV3TransferProjectionDatabaseAccess(operation)
}
