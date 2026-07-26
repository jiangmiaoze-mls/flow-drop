import {createHash} from 'node:crypto'
import {closeSync, createReadStream, existsSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'

import type {
  TransferFailureCode,
  TransferItem,
  TransferItemDescriptor,
  TransferTask,
  TransferTaskStatus
} from '@flowdrop/types'


type TransferRow = {
  chunk_size_bytes: number
  created_at: number
  failure_code: TransferFailureCode | null
  source_device_id: string
  status: TransferTaskStatus
  transfer_id: string
  updated_at: number
}

type TransferItemRow = {
  item_id: string
  kind: TransferItem['kind']
  mime_type: string
  name: string
  received_bytes: number
  sha256: string
  size_bytes: number
  status: TransferTaskStatus
  transfer_id: string
}

export type ReceivedChunk = {
  bytes: number
  chunkIndex: number
  sha256: string
}

export type IncomingTransferCreation = {
  chunkSizeBytes: number
  items: TransferItemDescriptor[]
  sourceDeviceId: string
  transferId: string
}

export class TransferStore {
  private readonly database: DatabaseSync
  private readonly incomingDirectory: string
  private readonly stagingDirectory: string

  constructor(rootDirectory = getDefaultTransferRoot()) {
    mkdirSync(rootDirectory, {recursive: true})
    this.incomingDirectory = path.join(rootDirectory, 'incoming')
    this.stagingDirectory = path.join(rootDirectory, 'staging')
    mkdirSync(this.incomingDirectory, {recursive: true})
    mkdirSync(this.stagingDirectory, {recursive: true})

    this.database = new DatabaseSync(path.join(rootDirectory, 'transfers.sqlite'))
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS transfers (
        transfer_id TEXT PRIMARY KEY,
        source_device_id TEXT NOT NULL,
        chunk_size_bytes INTEGER NOT NULL DEFAULT 1048576,
        status TEXT NOT NULL,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfer_items (
        transfer_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        PRIMARY KEY (transfer_id, item_id),
        FOREIGN KEY (transfer_id) REFERENCES transfers(transfer_id)
      );
      CREATE TABLE IF NOT EXISTS transfer_chunks (
        transfer_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (transfer_id, item_id, chunk_index)
      );
    `)
    const columns = this.database.prepare('PRAGMA table_info(transfers)').all() as {name: string}[]
    if (!columns.some((column) => column.name === 'chunk_size_bytes')) {
      this.database.exec(`ALTER TABLE transfers ADD COLUMN chunk_size_bytes INTEGER NOT NULL DEFAULT ${LEGACY_CHUNK_BYTES}`)
    }
  }

  close() {
    this.database.close()
  }

  createIncomingTransfer(creation: IncomingTransferCreation): TransferTask {
    const existing = this.get(creation.transferId)
    if (existing) return existing

    const now = Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO transfers (transfer_id, source_device_id, chunk_size_bytes, status, created_at, updated_at)
        VALUES (?, ?, ?, 'negotiating', ?, ?)
      `).run(creation.transferId, creation.sourceDeviceId, creation.chunkSizeBytes, now, now)

      for (const item of creation.items) {
        this.database.prepare(`
          INSERT INTO transfer_items (
            transfer_id, item_id, kind, name, mime_type, size_bytes, sha256, received_bytes, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'negotiating')
        `).run(
          creation.transferId,
          item.itemId,
          item.kind,
          item.name,
          item.mimeType,
          item.sizeBytes,
          item.sha256
        )

        if (item.kind === 'text') this.writeTextItem(creation.transferId, item)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }

    return this.require(creation.transferId)
  }

  writeChunk(transferId: string, itemId: string, chunk: ReceivedChunk, data: Buffer): TransferTask {
    const transfer = this.require(transferId)
    if (transfer.status === 'paused') throw new Error('TRANSFER_PAUSED')
    const item = this.getItem(transferId, itemId)
    if (!item || item.kind !== 'file') throw new Error('TRANSFER_ITEM_NOT_FOUND')

    const existingChunk = this.database.prepare(`
      SELECT byte_length, sha256 FROM transfer_chunks
      WHERE transfer_id = ? AND item_id = ? AND chunk_index = ?
    `).get(transferId, itemId, chunk.chunkIndex) as {byte_length: number; sha256: string} | undefined
    if (existingChunk) {
      if (existingChunk.byte_length !== chunk.bytes || existingChunk.sha256 !== chunk.sha256) {
        throw new Error('CHUNK_CONFLICT')
      }
      return this.require(transferId)
    }

    const offset = chunk.chunkIndex * transfer.chunkSizeBytes
    if (offset + data.length > item.sizeBytes) throw new Error('CHUNK_RANGE_INVALID')

    const itemStagingDirectory = this.getItemStagingDirectory(transferId)
    mkdirSync(itemStagingDirectory, {recursive: true})
    const stagingPath = this.getStagingPath(transferId, itemId)
    const descriptor = openSync(stagingPath, existsSync(stagingPath) ? 'r+' : 'w+')
    try {
      writeSync(descriptor, data, 0, data.length, offset)
    } finally {
      closeSync(descriptor)
    }

    const now = Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO transfer_chunks (transfer_id, item_id, chunk_index, byte_length, sha256)
        VALUES (?, ?, ?, ?, ?)
      `).run(transferId, itemId, chunk.chunkIndex, chunk.bytes, chunk.sha256)
      this.database.prepare(`
        UPDATE transfer_items
        SET received_bytes = received_bytes + ?, status = 'transferring'
        WHERE transfer_id = ? AND item_id = ?
      `).run(data.length, transferId, itemId)
      this.database.prepare(`
        UPDATE transfers SET status = 'transferring', updated_at = ? WHERE transfer_id = ?
      `).run(now, transferId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }

    return this.require(transferId)
  }

  async complete(transferId: string): Promise<TransferTask> {
    const task = this.require(transferId)
    if (task.status === 'completed') return task

    this.database.prepare(`
      UPDATE transfers SET status = 'verifying', updated_at = ? WHERE transfer_id = ?
    `).run(Date.now(), transferId)

    for (const item of this.getItems(transferId)) {
      if (item.receivedBytes !== item.sizeBytes) {
        return this.fail(transferId, 'INVALID_TRANSFER')
      }
      const stagingPath = this.getStagingPath(transferId, item.itemId)
      if (await sha256File(stagingPath) !== item.sha256) {
        return this.fail(transferId, 'HASH_MISMATCH')
      }
    }

    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const item of this.getItems(transferId)) {
        const destination = this.getFinalPath(transferId, item.itemId, item.name)
        renameSync(this.getStagingPath(transferId, item.itemId), destination)
        this.database.prepare(`
          UPDATE transfer_items SET status = 'completed' WHERE transfer_id = ? AND item_id = ?
        `).run(transferId, item.itemId)
      }
      this.database.prepare(`
        UPDATE transfers SET status = 'completed', failure_code = NULL, updated_at = ? WHERE transfer_id = ?
      `).run(Date.now(), transferId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }

    rmSync(this.getItemStagingDirectory(transferId), {force: true, recursive: true})
    return this.require(transferId)
  }

  cancel(transferId: string): TransferTask {
    this.require(transferId)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`UPDATE transfers SET status = 'cancelled', updated_at = ? WHERE transfer_id = ?`)
        .run(Date.now(), transferId)
      this.database.prepare(`UPDATE transfer_items SET status = 'cancelled' WHERE transfer_id = ?`)
        .run(transferId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    rmSync(this.getItemStagingDirectory(transferId), {force: true, recursive: true})
    return this.require(transferId)
  }

  pause(transferId: string): TransferTask {
    const task = this.require(transferId)
    if (task.status === 'paused') return task
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`UPDATE transfers SET status = 'paused', updated_at = ? WHERE transfer_id = ?`)
        .run(Date.now(), transferId)
      this.database.prepare(`UPDATE transfer_items SET status = 'paused' WHERE transfer_id = ? AND status != 'completed'`)
        .run(transferId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.require(transferId)
  }

  resume(transferId: string): TransferTask {
    const task = this.require(transferId)
    if (task.status !== 'paused') return task
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`UPDATE transfers SET status = 'negotiating', updated_at = ? WHERE transfer_id = ?`)
        .run(Date.now(), transferId)
      this.database.prepare(`UPDATE transfer_items SET status = 'negotiating' WHERE transfer_id = ? AND status = 'paused'`)
        .run(transferId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.require(transferId)
  }

  get(transferId: string): TransferTask | null {
    const transfer = this.database.prepare(`SELECT * FROM transfers WHERE transfer_id = ?`).get(transferId) as TransferRow | undefined
    return transfer ? toTransferTask(transfer, this.getItems(transferId)) : null
  }

  list(): TransferTask[] {
    const transfers = this.database.prepare(`
      SELECT * FROM transfers ORDER BY updated_at DESC LIMIT 100
    `).all() as TransferRow[]
    return transfers.map((transfer) => toTransferTask(transfer, this.getItems(transfer.transfer_id)))
  }

  getSourceDeviceId(transferId: string): string | null {
    const row = this.database.prepare(`SELECT source_device_id FROM transfers WHERE transfer_id = ?`).get(transferId) as {source_device_id: string} | undefined
    return row?.source_device_id ?? null
  }

  private fail(transferId: string, failureCode: TransferFailureCode): TransferTask {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        UPDATE transfers SET status = 'failed', failure_code = ?, updated_at = ? WHERE transfer_id = ?
      `).run(failureCode, Date.now(), transferId)
      this.database.prepare(`UPDATE transfer_items SET status = 'failed' WHERE transfer_id = ?`)
        .run(transferId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.require(transferId)
  }

  private getItem(transferId: string, itemId: string): TransferItem | null {
    const row = this.database.prepare(`
      SELECT * FROM transfer_items WHERE transfer_id = ? AND item_id = ?
    `).get(transferId, itemId) as TransferItemRow | undefined
    return row ? toTransferItem(row, this.getReceivedChunkIndexes(transferId, itemId)) : null
  }

  private getItems(transferId: string): TransferItem[] {
    const rows = this.database.prepare(`
      SELECT * FROM transfer_items WHERE transfer_id = ? ORDER BY item_id
    `).all(transferId) as TransferItemRow[]
    return rows.map((row) => toTransferItem(row, this.getReceivedChunkIndexes(transferId, row.item_id)))
  }

  private getReceivedChunkIndexes(transferId: string, itemId: string): number[] {
    return (this.database.prepare(`
      SELECT chunk_index FROM transfer_chunks WHERE transfer_id = ? AND item_id = ? ORDER BY chunk_index
    `).all(transferId, itemId) as {chunk_index: number}[]).map((chunk) => chunk.chunk_index)
  }

  private require(transferId: string): TransferTask {
    const transfer = this.get(transferId)
    if (!transfer) throw new Error('TRANSFER_NOT_FOUND')
    return transfer
  }

  private writeTextItem(transferId: string, item: TransferItemDescriptor) {
    const text = item.text ?? ''
    const content = Buffer.from(text, 'utf8')
    if (content.length !== item.sizeBytes || sha256(content) !== item.sha256) {
      throw new Error('TEXT_ITEM_HASH_MISMATCH')
    }
    mkdirSync(this.getItemStagingDirectory(transferId), {recursive: true})
    writeFileSync(this.getStagingPath(transferId, item.itemId), content, {flag: 'wx'})
    this.database.prepare(`
      UPDATE transfer_items SET received_bytes = ?, status = 'transferring' WHERE transfer_id = ? AND item_id = ?
    `).run(content.length, transferId, item.itemId)
  }

  private getItemStagingDirectory(transferId: string) {
    return path.join(this.stagingDirectory, transferId)
  }

  private getStagingPath(transferId: string, itemId: string) {
    return path.join(this.getItemStagingDirectory(transferId), `${itemId}.part`)
  }

  private getFinalPath(transferId: string, itemId: string, name: string) {
    return path.join(this.incomingDirectory, `${transferId}-${itemId}-${sanitizeFileName(name)}`)
  }
}

export const LEGACY_CHUNK_BYTES = 1024 * 1024
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024

function getDefaultTransferRoot() {
  const dataDirectory = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(dataDirectory, 'FlowDrop', 'transfers')
}

function toTransferItem(row: TransferItemRow, receivedChunkIndexes: number[]): TransferItem {
  return {
    itemId: row.item_id,
    kind: row.kind,
    mimeType: row.mime_type,
    name: row.name,
    receivedBytes: row.received_bytes,
    receivedChunkIndexes,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    status: row.status
  }
}

function toTransferTask(row: TransferRow, items: TransferItem[]): TransferTask {
  const totalBytes = items.reduce((total, item) => total + item.sizeBytes, 0)
  const transferredBytes = items.reduce((total, item) => total + item.receivedBytes, 0)
  return {
    chunkSizeBytes: row.chunk_size_bytes,
    createdAt: row.created_at,
    direction: 'receive',
    failureCode: row.failure_code ?? undefined,
    items,
    peerDeviceId: row.source_device_id,
    status: row.status,
    totalBytes,
    transferredBytes,
    transferId: row.transfer_id,
    updatedAt: row.updated_at,
    v: 1
  }
}

function sanitizeFileName(value: string) {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim()
  return sanitized || 'unnamed'
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: Buffer) => digest.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(digest.digest('hex')))
  })
}
