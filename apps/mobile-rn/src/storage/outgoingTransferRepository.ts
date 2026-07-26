import * as SQLite from 'expo-sqlite'

import type {TransferFailureCode, TransferItemDescriptor, TransferTaskStatus} from '@flowdrop/types'


export type OutgoingTransferItem = TransferItemDescriptor & {
  sourceUri?: string
  status: TransferTaskStatus
  transferredBytes: number
}

export type OutgoingTransferTask = {
  createdAt: number
  failureCode?: TransferFailureCode
  items: OutgoingTransferItem[]
  peerAddress: string
  peerControlPort: number
  peerDeviceId: string
  status: TransferTaskStatus
  totalBytes: number
  transferredBytes: number
  transferId: string
  updatedAt: number
}

export type CreateOutgoingTransfer = Omit<OutgoingTransferTask, 'createdAt' | 'status' | 'transferredBytes' | 'updatedAt'>

type TransferRow = {
  created_at: number
  failure_code: TransferFailureCode | null
  peer_address: string
  peer_control_port: number
  peer_device_id: string
  status: TransferTaskStatus
  total_bytes: number
  transferred_bytes: number
  transfer_id: string
  updated_at: number
}

type ItemRow = {
  item_id: string
  kind: OutgoingTransferItem['kind']
  mime_type: string
  name: string
  sha256: string
  size_bytes: number
  source_uri: string | null
  status: TransferTaskStatus
  text_content: string | null
  transfer_id: string
  transferred_bytes: number
}

const database = SQLite.openDatabaseSync('flowdrop.sqlite')

database.execSync(`
  CREATE TABLE IF NOT EXISTS outgoing_transfers (
    transfer_id TEXT PRIMARY KEY NOT NULL,
    peer_device_id TEXT NOT NULL,
    peer_address TEXT NOT NULL,
    peer_control_port INTEGER NOT NULL,
    status TEXT NOT NULL,
    failure_code TEXT,
    total_bytes INTEGER NOT NULL,
    transferred_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outgoing_transfer_items (
    transfer_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    source_uri TEXT,
    text_content TEXT,
    status TEXT NOT NULL,
    transferred_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (transfer_id, item_id),
    FOREIGN KEY (transfer_id) REFERENCES outgoing_transfers(transfer_id)
  );
`)

export function createOutgoingTransfer(input: CreateOutgoingTransfer): OutgoingTransferTask {
  const now = Date.now()
  runInTransaction(() => {
    database.runSync(
      `INSERT INTO outgoing_transfers (
        transfer_id, peer_device_id, peer_address, peer_control_port, status,
        total_bytes, transferred_bytes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
      input.transferId,
      input.peerDeviceId,
      input.peerAddress,
      input.peerControlPort,
      input.totalBytes,
      now,
      now
    )
    for (const item of input.items) {
      database.runSync(
        `INSERT INTO outgoing_transfer_items (
          transfer_id, item_id, kind, name, mime_type, size_bytes, sha256,
          source_uri, text_content, status, transferred_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0)`,
        input.transferId,
        item.itemId,
        item.kind,
        item.name,
        item.mimeType,
        item.sizeBytes,
        item.sha256,
        item.sourceUri ?? null,
        item.text ?? null
      )
    }
  })
  return requireTransfer(input.transferId)
}

export function listOutgoingTransfers(peerDeviceId: string): OutgoingTransferTask[] {
  const rows = database.getAllSync<TransferRow>(
    'SELECT * FROM outgoing_transfers WHERE peer_device_id = ? ORDER BY created_at ASC',
    peerDeviceId
  )
  return rows.map(toTask)
}

export function listAllOutgoingTransfers(): OutgoingTransferTask[] {
  const rows = database.getAllSync<TransferRow>('SELECT * FROM outgoing_transfers ORDER BY updated_at DESC')
  return rows.map(toTask)
}

export function getOutgoingTransfer(transferId: string): OutgoingTransferTask | null {
  const row = database.getFirstSync<TransferRow>('SELECT * FROM outgoing_transfers WHERE transfer_id = ?', transferId)
  return row ? toTask(row) : null
}

export function setOutgoingTransferStatus(
  transferId: string,
  status: TransferTaskStatus,
  options: {failureCode?: TransferFailureCode; transferredBytes?: number} = {}
): OutgoingTransferTask {
  const current = requireTransfer(transferId)
  const transferredBytes = options.transferredBytes ?? current.transferredBytes
  const now = Date.now()
  database.runSync(
    `UPDATE outgoing_transfers
     SET status = ?, failure_code = ?, transferred_bytes = ?, updated_at = ?
     WHERE transfer_id = ?`,
    status,
    options.failureCode ?? null,
    transferredBytes,
    now,
    transferId
  )
  database.runSync(
    'UPDATE outgoing_transfer_items SET status = ?, transferred_bytes = ? WHERE transfer_id = ?',
    status,
    transferredBytes,
    transferId
  )
  return requireTransfer(transferId)
}

export function setOutgoingTransferPreparationProgress(
  transferId: string,
  itemId: string,
  totalBytes: number,
  preparedBytes: number
): OutgoingTransferTask {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || !Number.isSafeInteger(preparedBytes) || preparedBytes < 0 || preparedBytes > totalBytes) {
    throw new Error('INVALID_PREPARATION_PROGRESS')
  }
  const now = Date.now()
  runInTransaction(() => {
    requireTransfer(transferId)
    database.runSync(
      `UPDATE outgoing_transfers
       SET status = 'preparing', failure_code = NULL, total_bytes = ?, transferred_bytes = ?, updated_at = ?
       WHERE transfer_id = ?`,
      totalBytes,
      preparedBytes,
      now,
      transferId
    )
    database.runSync(
      `UPDATE outgoing_transfer_items
       SET status = 'preparing', size_bytes = ?, transferred_bytes = ?
       WHERE transfer_id = ? AND item_id = ?`,
      totalBytes,
      preparedBytes,
      transferId,
      itemId
    )
  })
  return requireTransfer(transferId)
}

export function replaceOutgoingTransferItems(
  transferId: string,
  items: OutgoingTransferItem[],
  status: TransferTaskStatus = 'queued'
): OutgoingTransferTask {
  const now = Date.now()
  runInTransaction(() => {
    requireTransfer(transferId)
    database.runSync('DELETE FROM outgoing_transfer_items WHERE transfer_id = ?', transferId)
    for (const item of items) {
      database.runSync(
        `INSERT INTO outgoing_transfer_items (
          transfer_id, item_id, kind, name, mime_type, size_bytes, sha256,
          source_uri, text_content, status, transferred_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        transferId,
        item.itemId,
        item.kind,
        item.name,
        item.mimeType,
        item.sizeBytes,
        item.sha256,
        item.sourceUri ?? null,
        item.text ?? null,
        status,
        0
      )
    }
    database.runSync(
      `UPDATE outgoing_transfers
       SET status = ?, failure_code = NULL, total_bytes = ?, transferred_bytes = 0, updated_at = ?
       WHERE transfer_id = ?`,
      status,
      items.reduce((total, item) => total + item.sizeBytes, 0),
      now,
      transferId
    )
  })
  return requireTransfer(transferId)
}

export function deleteOutgoingTransfer(transferId: string) {
  runInTransaction(() => {
    database.runSync('DELETE FROM outgoing_transfer_items WHERE transfer_id = ?', transferId)
    database.runSync('DELETE FROM outgoing_transfers WHERE transfer_id = ?', transferId)
  })
}

function requireTransfer(transferId: string): OutgoingTransferTask {
  const task = getOutgoingTransfer(transferId)
  if (!task) throw new Error('TRANSFER_NOT_FOUND')
  return task
}

function toTask(row: TransferRow): OutgoingTransferTask {
  const items = database.getAllSync<ItemRow>(
    'SELECT * FROM outgoing_transfer_items WHERE transfer_id = ? ORDER BY item_id',
    row.transfer_id
  ).map((item) => ({
    itemId: item.item_id,
    kind: item.kind,
    mimeType: item.mime_type,
    name: item.name,
    sha256: item.sha256,
    sizeBytes: item.size_bytes,
    sourceUri: item.source_uri ?? undefined,
    status: item.status,
    text: item.text_content ?? undefined,
    transferredBytes: item.transferred_bytes
  }))
  return {
    createdAt: row.created_at,
    failureCode: row.failure_code ?? undefined,
    items,
    peerAddress: row.peer_address,
    peerControlPort: row.peer_control_port,
    peerDeviceId: row.peer_device_id,
    status: row.status,
    totalBytes: row.total_bytes,
    transferredBytes: row.transferred_bytes,
    transferId: row.transfer_id,
    updatedAt: row.updated_at
  }
}

function runInTransaction(operation: () => void) {
  database.execSync('BEGIN IMMEDIATE')
  try {
    operation()
    database.execSync('COMMIT')
  } catch (error) {
    database.execSync('ROLLBACK')
    throw error
  }
}
