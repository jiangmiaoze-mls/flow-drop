import {mkdirSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {parentPort, workerData} from 'node:worker_threads'

import {calculateV3ContentRootFromHexDigests, isV3ContentRootHex} from './v3ContentRoot'
import {migrateV3TransferDatabase} from './v3Migration'
import {getV3TransferDatabasePath} from './v3TransferStore'
import {V3TransportError} from './v3TransportError'
import type {
  V3AdminTransferSnapshot,
  V3ChunkAck,
  V3ChunkDigestPage,
  V3CompletionFile,
  V3CreateTransferResponse,
  V3ItemProgress,
  V3TransferControlResponse,
  V3TransferStatus,
  V3TransferStatusSnapshot,
  V3VerificationPhase
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
  V3TransferWorkerResponse,
  V3TransferWorkerSuccessResult
} from './v3TransferWorkerProtocol'

type V3TransferRow = {
  chunk_size_bytes: number
  completion_attempt: number
  created_at: number
  failure_code: string | null
  received_bytes: number
  revision: number
  source_device_id: string
  status: V3TransferStatus
  transfer_id: string
  updated_at: number
  verifying_bytes: number
  verifying_phase: V3VerificationPhase
  verifying_total_bytes: number
}

type V3TransferItemRow = {
  item_id: string
  item_ordinal: number
  mime_type: string
  name: string
  received_bytes: number
  size_bytes: number
  transfer_id: string
}

type V3TransferChunkRow = {
  byte_length: number
  chunk_index: number
  item_id: string
  sha256: string
}

type V3CompletionItemRow = {
  actual_content_root: string | null
  durable_content_root: string
  item_id: string
  requested_content_root: string
}

const rootDirectory = getWorkerRootDirectory(workerData)
mkdirSync(rootDirectory, {recursive: true})

const database = new DatabaseSync(getV3TransferDatabasePath(rootDirectory))
database.exec('PRAGMA foreign_keys = ON')
database.exec('PRAGMA journal_mode = WAL')
migrateV3TransferDatabase(database)

const port = parentPort
if (!port) throw new Error('V3 transfer database worker has no parent port.')

let closed = false
port.on('message', (message: unknown) => {
  if (!isWorkerRequest(message)) return
  const response: V3TransferWorkerResponse = {id: message.id}
  try {
    response.result = handleRequest(message.payload)
  } catch (error) {
    response.error = serializeError(error)
  }
  port.postMessage(response)
})
port.postMessage({type: 'ready'})

function handleRequest(request: V3TransferWorkerRequest['payload']): V3TransferWorkerSuccessResult {
  if (closed && request.type !== 'close') throw new V3TransportError('TRANSFER_STORAGE_CLOSED', 503)
  switch (request.type) {
    case 'createOrGet':
      return createOrGet(request.creation)
    case 'getChunkWriteTarget':
      return getChunkWriteTarget(request.transferId, request.itemId)
    case 'getChunkAck':
      return getChunkAck(request.transferId, request.itemId, request.chunkIndex)
    case 'preflightChunkBatch':
      return preflightChunkBatch(request.transferId, request.sourceDeviceId, request.chunks)
    case 'commitChunkBatch':
      return commitChunkBatch(
        request.transferId,
        request.sourceDeviceId,
        request.newChunks,
        request.acknowledgementChunks
      )
    case 'beginCompletion':
      return beginCompletion(request.transferId, request.sourceDeviceId, request.files)
    case 'pauseTransfer':
      return pauseTransfer(request.transferId, request.sourceDeviceId)
    case 'resumeTransfer':
      return resumeTransfer(request.transferId, request.sourceDeviceId)
    case 'cancelTransfer':
      return cancelTransfer(request.transferId, request.sourceDeviceId)
    case 'getStatus':
      return getStatus(request.transferId, request.sourceDeviceId)
    case 'getChunkDigests':
      return getChunkDigests(
        request.transferId,
        request.itemId,
        request.sourceDeviceId,
        request.offset,
        request.limit
      )
    case 'getCompletionVerificationPlan':
      return getCompletionVerificationPlan(request.transferId, request.completionAttempt)
    case 'setVerificationProgress':
      return setVerificationProgress(
        request.transferId,
        request.completionAttempt,
        request.verifyingBytes,
        request.verifyingTotalBytes,
        request.verifyingPhase
      )
    case 'markTransferCompleted':
      return markTransferCompleted(request.transferId, request.completionAttempt, request.actualFiles)
    case 'markTransferFailed':
      return markTransferFailed(
        request.transferId,
        request.completionAttempt,
        request.errorCode,
        request.verifyingBytes,
        request.verifyingTotalBytes,
        request.verifyingPhase
      )
    case 'listCancelledTransferIds':
      return listCancelledTransferIds()
    case 'listForAdmin':
      return listForAdmin()
    case 'close':
      if (!closed) {
        closed = true
        database.close()
      }
      return null
  }
}

function createOrGet(creation: V3TransferCreation): {created: boolean; response: V3CreateTransferResponse} {
  let created = false
  inTransaction(() => {
    const existing = getStoredCreation(creation.transferId)
    if (existing) {
      if (!sameCreation(existing, creation)) throw new V3TransportError('TRANSFER_ID_CONFLICT', 409)
      return
    }

    const now = Date.now()
    database.prepare(`
      INSERT INTO v3_transfers (
        transfer_id, source_device_id, chunk_size_bytes, status, revision, received_bytes, created_at, updated_at
      ) VALUES (?, ?, ?, 'negotiating', 0, 0, ?, ?)
    `).run(creation.transferId, creation.sourceDeviceId, creation.chunkSizeBytes, now, now)

    const insertItem = database.prepare(`
      INSERT INTO v3_transfer_items (
        transfer_id, item_id, name, mime_type, size_bytes, received_bytes, item_ordinal
      ) VALUES (?, ?, ?, ?, ?, 0, ?)
    `)
    for (const [itemOrdinal, item] of creation.items.entries()) {
      insertItem.run(
        creation.transferId,
        item.itemId,
        item.name,
        item.mimeType,
        item.sizeBytes,
        itemOrdinal
      )
    }
    created = true
  })

  return {created, response: getCreateResponse(creation.transferId)}
}

function getChunkWriteTarget(transferId: string, itemId: string): V3ChunkWriteTarget | null {
  const row = database.prepare(`
    SELECT t.source_device_id, t.chunk_size_bytes, t.status, i.size_bytes
    FROM v3_transfers t
    JOIN v3_transfer_items i ON i.transfer_id = t.transfer_id
    WHERE t.transfer_id = ? AND i.item_id = ?
  `).get(transferId, itemId) as {
    chunk_size_bytes: number
    size_bytes: number
    source_device_id: string
    status: V3TransferStatus
  } | undefined
  if (!row) return null
  return {
    chunkSizeBytes: row.chunk_size_bytes,
    itemSizeBytes: row.size_bytes,
    sourceDeviceId: row.source_device_id,
    status: row.status
  }
}

function preflightChunkBatch(
  transferId: string,
  sourceDeviceId: string,
  chunks: V3ChunkMetadata[]
): V3ChunkPreflightResult[] {
  assertTransferOwnerAndWritable(transferId, sourceDeviceId)
  return chunks.map((chunk) => {
    try {
      validateChunkMetadata(transferId, chunk)
      const existing = getStoredChunk(transferId, chunk.itemId, chunk.chunkIndex)
      if (!existing) return {jobId: chunk.jobId, state: 'new'}
      if (existing.byte_length !== chunk.sizeBytes || existing.sha256 !== chunk.sha256) {
        throw new V3TransportError('CHUNK_CONFLICT', 409)
      }
      return {jobId: chunk.jobId, state: 'duplicate'}
    } catch (error) {
      return {
        error: serializeError(error),
        jobId: chunk.jobId,
        state: 'new'
      }
    }
  })
}

function commitChunkBatch(
  transferId: string,
  sourceDeviceId: string,
  newChunks: V3ChunkMetadata[],
  acknowledgementChunks: V3ChunkMetadata[]
): V3ChunkBatchCommitResult {
  return inTransaction(() => {
    assertTransferOwnerAndWritable(transferId, sourceDeviceId)
    assertUniqueChunkKeys(newChunks)

    const chunksToInsert: V3ChunkMetadata[] = []
    for (const chunk of newChunks) {
      validateChunkMetadata(transferId, chunk)
      const existing = getStoredChunk(transferId, chunk.itemId, chunk.chunkIndex)
      if (existing) {
        if (existing.byte_length !== chunk.sizeBytes || existing.sha256 !== chunk.sha256) {
          throw new V3TransportError('CHUNK_CONFLICT', 409)
        }
        continue
      }
      chunksToInsert.push(chunk)
    }

    if (chunksToInsert.length > 0) {
      const insertChunk = database.prepare(`
        INSERT INTO v3_transfer_chunks (transfer_id, item_id, chunk_index, byte_length, sha256)
        VALUES (?, ?, ?, ?, ?)
      `)
      const itemDeltas = new Map<string, number>()
      for (const chunk of chunksToInsert) {
        insertChunk.run(transferId, chunk.itemId, chunk.chunkIndex, chunk.sizeBytes, chunk.sha256)
        itemDeltas.set(chunk.itemId, (itemDeltas.get(chunk.itemId) ?? 0) + chunk.sizeBytes)
      }

      const updateItem = database.prepare(`
        UPDATE v3_transfer_items
        SET received_bytes = received_bytes + ?
        WHERE transfer_id = ? AND item_id = ?
      `)
      for (const [itemId, bytes] of itemDeltas) updateItem.run(bytes, transferId, itemId)

      const receivedBytes = chunksToInsert.reduce((total, chunk) => total + chunk.sizeBytes, 0)
      database.prepare(`
        UPDATE v3_transfers
        SET status = 'transferring', received_bytes = received_bytes + ?, revision = revision + 1, updated_at = ?
        WHERE transfer_id = ?
      `).run(receivedBytes, Date.now(), transferId)
    }

    return {
      acknowledgements: acknowledgementChunks.map((chunk) => ({
        ack: getChunkAck(transferId, chunk.itemId, chunk.chunkIndex),
        jobId: chunk.jobId
      })),
      committed: chunksToInsert.length > 0
    }
  })
}

function beginCompletion(
  transferId: string,
  sourceDeviceId: string,
  files: V3CompletionFile[]
): V3CompletionBeginResult {
  return inTransaction(() => {
    let transfer = assertTransferOwner(transferId, sourceDeviceId)
    const items = getItems(transferId)
    assertExactCompletionFiles(files, items)
    const completionRows = getCompletionItems(transferId)

    if (transfer.status === 'completed' || transfer.status === 'completing') {
      assertSameCompletionFiles(files, completionRows)
      return {
        completionAttempt: transfer.completion_attempt,
        disposition: transfer.status === 'completed' ? 'already-completed' : 'already-completing',
        snapshot: toStatusSnapshot(transfer, items)
      }
    }

    if (transfer.status === 'paused' || transfer.status === 'cancelled') {
      throw new V3TransportError('TRANSFER_STATE_INVALID', 409)
    }

    if (transfer.status === 'failed') {
      assertSameCompletionFiles(files, completionRows)
      if (transfer.failure_code !== 'PART_READ_ERROR') {
        return {
          completionAttempt: transfer.completion_attempt,
          disposition: 'failed',
          snapshot: toStatusSnapshot(transfer, items)
        }
      }
    }

    const retryingPartRead = transfer.status === 'failed' && transfer.failure_code === 'PART_READ_ERROR'
    const durableRoots = deriveDurableContentRoots(transfer, items)
    const totalBytes = getTotalBytes(items)
    if (!sameCompletionRoots(files, durableRoots)) {
      if (completionRows.length === 0) insertCompletionItems(transferId, files, durableRoots)
      else updateCompletionItems(transferId, files, durableRoots)
      transfer = markContentRootMismatch(transferId, totalBytes)
      return {
        completionAttempt: transfer.completion_attempt,
        disposition: 'failed',
        snapshot: toStatusSnapshot(transfer, items)
      }
    }

    if (completionRows.length === 0) insertCompletionItems(transferId, files, durableRoots)
    else updateCompletionItems(transferId, files, durableRoots)
    transfer = transitionToCompleting(transferId, totalBytes, retryingPartRead)
    const snapshot = toStatusSnapshot(transfer, items)
    return {
      completionAttempt: transfer.completion_attempt,
      disposition: retryingPartRead ? 'retrying' : 'accepted',
      snapshot,
      verificationPlan: toCompletionVerificationPlan(transfer, items)
    }
  })
}

function pauseTransfer(transferId: string, sourceDeviceId: string): V3TransferControlResponse {
  return inTransaction(() => {
    const transfer = assertTransferOwner(transferId, sourceDeviceId)
    if (transfer.status === 'paused') return toControlResponse(transfer)
    if (!isPausableTransferStatus(transfer.status)) {
      throw new V3TransportError('TRANSFER_STATE_INVALID', 409)
    }
    database.prepare(`
      UPDATE v3_transfers
      SET status = 'paused', revision = revision + 1, updated_at = ?
      WHERE transfer_id = ?
    `).run(Date.now(), transferId)
    return toControlResponse(requireTransfer(transferId))
  })
}

function resumeTransfer(transferId: string, sourceDeviceId: string): V3TransferControlResponse {
  return inTransaction(() => {
    const transfer = assertTransferOwner(transferId, sourceDeviceId)
    if (transfer.status === 'transferring') return toControlResponse(transfer)
    if (transfer.status !== 'paused') {
      throw new V3TransportError('TRANSFER_STATE_INVALID', 409)
    }
    database.prepare(`
      UPDATE v3_transfers
      SET status = 'transferring', revision = revision + 1, updated_at = ?
      WHERE transfer_id = ?
    `).run(Date.now(), transferId)
    return toControlResponse(requireTransfer(transferId))
  })
}

function cancelTransfer(transferId: string, sourceDeviceId: string): V3TransferControlResponse {
  return inTransaction(() => {
    const transfer = assertTransferOwner(transferId, sourceDeviceId)
    if (transfer.status === 'cancelled') return toControlResponse(transfer)
    if (!isCancellableTransferStatus(transfer.status)) {
      throw new V3TransportError('TRANSFER_STATE_INVALID', 409)
    }
    database.prepare(`
      UPDATE v3_transfers
      SET status = 'cancelled', failure_code = NULL,
          verifying_phase = CASE WHEN status = 'completing' THEN 'done' ELSE verifying_phase END,
          revision = revision + 1, updated_at = ?
      WHERE transfer_id = ?
    `).run(Date.now(), transferId)
    return toControlResponse(requireTransfer(transferId))
  })
}

function getStatus(transferId: string, sourceDeviceId: string): V3TransferStatusSnapshot {
  const transfer = assertTransferOwner(transferId, sourceDeviceId)
  return toStatusSnapshot(transfer, getItems(transferId))
}

function getChunkDigests(
  transferId: string,
  itemId: string,
  sourceDeviceId: string,
  offset: number,
  limit: number
): V3ChunkDigestPage {
  assertTransferOwner(transferId, sourceDeviceId)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
    throw new V3TransportError('INVALID_CHUNK_DIGEST_PAGE', 400)
  }
  if (!getItem(transferId, itemId)) throw new V3TransportError('TRANSFER_ITEM_NOT_FOUND', 404)
  const total = (database.prepare(`
    SELECT COUNT(*) AS count FROM v3_transfer_chunks WHERE transfer_id = ? AND item_id = ?
  `).get(transferId, itemId) as {count: number}).count
  const rows = database.prepare(`
    SELECT chunk_index, byte_length, sha256
    FROM v3_transfer_chunks
    WHERE transfer_id = ? AND item_id = ?
    ORDER BY chunk_index
    LIMIT ? OFFSET ?
  `).all(transferId, itemId, limit, offset) as Array<{
    byte_length: number
    chunk_index: number
    sha256: string
  }>
  return {
    digests: rows.map((row) => ({index: row.chunk_index, length: row.byte_length, sha256: row.sha256})),
    total
  }
}

function getCompletionVerificationPlan(
  transferId: string,
  completionAttempt: number
): V3CompletionVerificationPlan | null {
  const transfer = getTransfer(transferId)
  if (!transfer || transfer.status !== 'completing' || transfer.completion_attempt !== completionAttempt) return null
  return toCompletionVerificationPlan(transfer, getItems(transferId))
}

function setVerificationProgress(
  transferId: string,
  completionAttempt: number,
  verifyingBytes: number,
  verifyingTotalBytes: number,
  verifyingPhase: V3VerificationPhase
): V3CompletionMutationResult {
  return inTransaction(() => {
    const transfer = requireTransfer(transferId)
    const items = getItems(transferId)
    if (!isCurrentCompletionAttempt(transfer, completionAttempt)) {
      return {applied: false, snapshot: toStatusSnapshot(transfer, items)}
    }
    const totalBytes = getTotalBytes(items)
    assertVerificationProgress(verifyingBytes, verifyingTotalBytes, verifyingPhase, totalBytes)
    const phaseRegresses = verificationPhaseRank(verifyingPhase) < verificationPhaseRank(transfer.verifying_phase)
    if (phaseRegresses) {
      return {applied: false, snapshot: toStatusSnapshot(transfer, items)}
    }
    // A manual retry after PART_READ_ERROR is a new read pass. The status API has
    // no attempt field, so retain the externally visible byte high-water mark.
    const nextVerifyingBytes = Math.max(transfer.verifying_bytes, verifyingBytes)
    if (
      transfer.verifying_bytes === nextVerifyingBytes
      && transfer.verifying_total_bytes === verifyingTotalBytes
      && transfer.verifying_phase === verifyingPhase
    ) {
      return {applied: true, snapshot: toStatusSnapshot(transfer, items)}
    }
    database.prepare(`
      UPDATE v3_transfers
      SET verifying_bytes = ?, verifying_total_bytes = ?, verifying_phase = ?, revision = revision + 1, updated_at = ?
      WHERE transfer_id = ?
    `).run(nextVerifyingBytes, verifyingTotalBytes, verifyingPhase, Date.now(), transferId)
    return {applied: true, snapshot: toStatusSnapshot(requireTransfer(transferId), items)}
  })
}

function markTransferCompleted(
  transferId: string,
  completionAttempt: number,
  actualFiles: V3CompletionFile[]
): V3CompletionMutationResult {
  return inTransaction(() => {
    const transfer = requireTransfer(transferId)
    const items = getItems(transferId)
    if (!isCurrentCompletionAttempt(transfer, completionAttempt)) {
      return {applied: false, snapshot: toStatusSnapshot(transfer, items)}
    }
    const totalBytes = getTotalBytes(items)
    const completionRows = getCompletionItems(transferId)
    const actualFilesAreValid = areExactCompletionFiles(actualFiles, items)
      && actualFiles.every((file) => isV3ContentRootHex(file.contentRoot))
    const rootsMatch = actualFilesAreValid && sameActualRoots(actualFiles, completionRows)
    if (!rootsMatch) {
      storeActualRoots(transferId, actualFiles)
      database.prepare(`
        UPDATE v3_transfers
        SET status = 'failed', failure_code = 'PART_CONTENT_ROOT_MISMATCH',
            verifying_bytes = ?, verifying_total_bytes = ?, verifying_phase = 'done',
            revision = revision + 1, updated_at = ?
        WHERE transfer_id = ?
      `).run(totalBytes, totalBytes, Date.now(), transferId)
      return {applied: true, snapshot: toStatusSnapshot(requireTransfer(transferId), items)}
    }

    const updateRoot = database.prepare(`
      UPDATE v3_transfer_completion_items
      SET actual_content_root = ?
      WHERE transfer_id = ? AND item_id = ?
    `)
    for (const file of actualFiles) updateRoot.run(file.contentRoot, transferId, file.itemId)
    database.prepare(`
      UPDATE v3_transfers
      SET status = 'completed', failure_code = NULL,
          verifying_bytes = ?, verifying_total_bytes = ?, verifying_phase = 'done',
          revision = revision + 1, updated_at = ?
      WHERE transfer_id = ?
    `).run(totalBytes, totalBytes, Date.now(), transferId)
    return {applied: true, snapshot: toStatusSnapshot(requireTransfer(transferId), items)}
  })
}

function markTransferFailed(
  transferId: string,
  completionAttempt: number,
  errorCode: 'PART_CONTENT_ROOT_MISMATCH' | 'PART_READ_ERROR',
  verifyingBytes: number,
  verifyingTotalBytes: number,
  verifyingPhase: V3VerificationPhase
): V3CompletionMutationResult {
  return inTransaction(() => {
    const transfer = requireTransfer(transferId)
    const items = getItems(transferId)
    if (!isCurrentCompletionAttempt(transfer, completionAttempt)) {
      return {applied: false, snapshot: toStatusSnapshot(transfer, items)}
    }
    const totalBytes = getTotalBytes(items)
    assertVerificationProgress(verifyingBytes, verifyingTotalBytes, verifyingPhase, totalBytes)
    const visibleVerifyingBytes = Math.max(transfer.verifying_bytes, verifyingBytes)
    database.prepare(`
      UPDATE v3_transfers
      SET status = 'failed', failure_code = ?,
          verifying_bytes = ?, verifying_total_bytes = ?, verifying_phase = 'done',
          revision = revision + 1, updated_at = ?
      WHERE transfer_id = ?
    `).run(errorCode, visibleVerifyingBytes, verifyingTotalBytes, Date.now(), transferId)
    return {applied: true, snapshot: toStatusSnapshot(requireTransfer(transferId), items)}
  })
}

function listForAdmin(): V3AdminTransferSnapshot[] {
  const transfers = database.prepare(`
    SELECT * FROM v3_transfers ORDER BY updated_at DESC LIMIT 100
  `).all() as V3TransferRow[]
  return transfers.map((transfer) => {
    const items = getItems(transfer.transfer_id)
    return {
      chunkSizeBytes: transfer.chunk_size_bytes,
      createdAt: transfer.created_at,
      direction: 'receive',
      ...(transfer.failure_code ? {errorCode: transfer.failure_code} : {}),
      items: items.map((item) => ({
        itemId: item.item_id,
        mimeType: item.mime_type,
        name: item.name,
        receivedBytes: item.received_bytes,
        sizeBytes: item.size_bytes
      })),
      peerDeviceId: transfer.source_device_id,
      revision: transfer.revision,
      status: transfer.status,
      totalBytes: getTotalBytes(items),
      transferId: transfer.transfer_id,
      transferredBytes: transfer.received_bytes,
      updatedAt: transfer.updated_at,
      verifyingBytes: transfer.verifying_bytes,
      verifyingPhase: transfer.verifying_phase,
      verifyingTotalBytes: transfer.verifying_total_bytes
    }
  })
}

function listCancelledTransferIds(): string[] {
  return (database.prepare(`
    SELECT transfer_id FROM v3_transfers WHERE status = 'cancelled'
  `).all() as Array<{transfer_id: string}>).map((row) => row.transfer_id)
}

function assertTransferOwnerAndWritable(transferId: string, sourceDeviceId: string): V3TransferRow {
  const transfer = assertTransferOwner(transferId, sourceDeviceId)
  if (transfer.status === 'paused') {
    throw new V3TransportError('TRANSFER_PAUSED', 409)
  }
  if (transfer.status !== 'negotiating' && transfer.status !== 'transferring') {
    throw new V3TransportError('TRANSFER_CLOSING', 409)
  }
  return transfer
}

function toControlResponse(transfer: V3TransferRow): V3TransferControlResponse {
  if (transfer.status !== 'paused' && transfer.status !== 'transferring' && transfer.status !== 'cancelled') {
    throw new V3TransportError('TRANSFER_INTERNAL_ERROR', 500)
  }
  return {revision: transfer.revision, status: transfer.status}
}

function isPausableTransferStatus(status: V3TransferStatus) {
  return status === 'negotiating'
    || status === 'queued'
    || status === 'waiting_for_peer'
    || status === 'preparing'
    || status === 'recovering'
    || status === 'transferring'
}

function isCancellableTransferStatus(status: V3TransferStatus) {
  return status === 'paused' || status === 'completing' || isPausableTransferStatus(status)
}

function assertTransferOwner(transferId: string, sourceDeviceId: string): V3TransferRow {
  const transfer = getTransfer(transferId)
  if (!transfer) throw new V3TransportError('TRANSFER_NOT_FOUND', 404)
  if (transfer.source_device_id !== sourceDeviceId) throw new V3TransportError('TRANSFER_FORBIDDEN', 403)
  return transfer
}

function validateChunkMetadata(transferId: string, chunk: V3ChunkMetadata) {
  if (!Number.isSafeInteger(chunk.jobId) || !Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) {
    throw new V3TransportError('INVALID_CHUNK', 400)
  }
  if (!Number.isSafeInteger(chunk.sizeBytes) || chunk.sizeBytes <= 0 || !/^[a-f0-9]{64}$/i.test(chunk.sha256)) {
    throw new V3TransportError('INVALID_CHUNK', 400)
  }
  const target = getChunkWriteTarget(transferId, chunk.itemId)
  if (!target) throw new V3TransportError('TRANSFER_ITEM_NOT_FOUND', 404)
  const offset = chunk.chunkIndex * target.chunkSizeBytes
  const expectedLength = Math.min(target.chunkSizeBytes, target.itemSizeBytes - offset)
  if (!Number.isSafeInteger(offset) || expectedLength <= 0 || chunk.sizeBytes !== expectedLength) {
    throw new V3TransportError('INVALID_CONTENT_RANGE', 400)
  }
}

function assertUniqueChunkKeys(chunks: V3ChunkMetadata[]) {
  const keys = new Set<string>()
  for (const chunk of chunks) {
    const key = `${chunk.itemId}:${chunk.chunkIndex}`
    if (keys.has(key)) throw new V3TransportError('INVALID_CHUNK', 400)
    keys.add(key)
  }
}

function getCreateResponse(transferId: string): V3CreateTransferResponse {
  const transfer = requireTransfer(transferId)
  const items = getItems(transferId)
  return {
    chunkSizeBytes: transfer.chunk_size_bytes,
    items: items.map((item) => toItemProgress(transferId, item)),
    protocol: 3,
    revision: transfer.revision,
    status: transfer.status,
    transferId,
    transferReceivedBytes: transfer.received_bytes
  }
}

function getChunkAck(transferId: string, itemId: string, chunkIndex: number): V3ChunkAck {
  const transfer = getTransfer(transferId)
  const item = getItem(transferId, itemId)
  const chunk = getStoredChunk(transferId, itemId, chunkIndex)
  if (!transfer || !item || !chunk) throw new V3TransportError('TRANSFER_CHUNK_NOT_FOUND', 404)
  return {
    chunkIndex,
    itemId,
    receivedBytes: item.received_bytes,
    revision: transfer.revision,
    transferReceivedBytes: transfer.received_bytes
  }
}

function toItemProgress(transferId: string, item: V3TransferItemRow): V3ItemProgress {
  return {
    itemId: item.item_id,
    receivedBytes: item.received_bytes,
    receivedRanges: getReceivedRanges(transferId, item.item_id)
  }
}

function toStatusSnapshot(transfer: V3TransferRow, items: V3TransferItemRow[]): V3TransferStatusSnapshot {
  return {
    ...(transfer.failure_code ? {errorCode: transfer.failure_code} : {}),
    items: items.map((item) => ({
      itemId: item.item_id,
      receivedRanges: getReceivedRanges(transfer.transfer_id, item.item_id)
    })),
    revision: transfer.revision,
    status: transfer.status,
    transferReceivedBytes: transfer.received_bytes,
    verifyingBytes: transfer.verifying_bytes,
    verifyingPhase: transfer.verifying_phase,
    verifyingTotalBytes: transfer.verifying_total_bytes
  }
}

function getReceivedRanges(transferId: string, itemId: string): Array<[start: number, end: number]> {
  const rows = database.prepare(`
    SELECT chunk_index FROM v3_transfer_chunks
    WHERE transfer_id = ? AND item_id = ?
    ORDER BY chunk_index
  `).all(transferId, itemId) as Array<{chunk_index: number}>
  const ranges: Array<[start: number, end: number]> = []
  for (const row of rows) {
    const previous = ranges[ranges.length - 1]
    if (previous && row.chunk_index === previous[1] + 1) {
      previous[1] = row.chunk_index
    } else {
      ranges.push([row.chunk_index, row.chunk_index])
    }
  }
  return ranges
}

function deriveDurableContentRoots(
  transfer: V3TransferRow,
  items: V3TransferItemRow[]
): V3CompletionFile[] {
  return items.map((item) => {
    const chunks = getItemChunks(transfer.transfer_id, item.item_id)
    const expectedChunkCount = Math.ceil(item.size_bytes / transfer.chunk_size_bytes)
    if (chunks.length !== expectedChunkCount) throw new V3TransportError('TRANSFER_INCOMPLETE', 409)
    try {
      return {
        contentRoot: calculateV3ContentRootFromHexDigests({
          chunkSizeBytes: transfer.chunk_size_bytes,
          chunks: chunks.map((chunk) => ({
            index: chunk.chunk_index,
            length: chunk.byte_length,
            sha256: chunk.sha256
          })),
          fileSizeBytes: item.size_bytes
        }),
        itemId: item.item_id
      }
    } catch {
      throw new V3TransportError('TRANSFER_DURABLE_CONTENT_INVALID', 500)
    }
  })
}

function assertExactCompletionFiles(files: V3CompletionFile[], items: V3TransferItemRow[]) {
  if (!areExactCompletionFiles(files, items) || !files.every((file) => isV3ContentRootHex(file.contentRoot))) {
    throw new V3TransportError('INVALID_COMPLETION_FILES', 400)
  }
}

function areExactCompletionFiles(files: unknown, items: V3TransferItemRow[]): files is V3CompletionFile[] {
  return Array.isArray(files) && files.length === items.length && files.every((file, index) => {
    const item = items[index]
    return isCompletionFile(file) && item !== undefined && file.itemId === item.item_id
  })
}

function assertSameCompletionFiles(files: V3CompletionFile[], completionRows: V3CompletionItemRow[]) {
  if (!sameRequestedRoots(files, completionRows)) throw new V3TransportError('TRANSFER_COMPLETION_CONFLICT', 409)
}

function sameRequestedRoots(files: V3CompletionFile[], rows: V3CompletionItemRow[]) {
  return files.length === rows.length && files.every((file, index) => {
    const row = rows[index]
    return row !== undefined && file.itemId === row.item_id && file.contentRoot === row.requested_content_root
  })
}

function sameCompletionRoots(files: V3CompletionFile[], durableRoots: V3CompletionFile[]) {
  return files.length === durableRoots.length && files.every((file, index) => {
    const durable = durableRoots[index]
    return durable !== undefined && file.itemId === durable.itemId && file.contentRoot === durable.contentRoot
  })
}

function sameActualRoots(actualFiles: V3CompletionFile[], rows: V3CompletionItemRow[]) {
  return actualFiles.length === rows.length && actualFiles.every((file, index) => {
    const row = rows[index]
    return row !== undefined
      && file.itemId === row.item_id
      && file.contentRoot === row.requested_content_root
      && file.contentRoot === row.durable_content_root
  })
}

function insertCompletionItems(
  transferId: string,
  files: V3CompletionFile[],
  durableRoots: V3CompletionFile[]
) {
  const insert = database.prepare(`
    INSERT INTO v3_transfer_completion_items (
      transfer_id, item_id, requested_content_root, durable_content_root, actual_content_root
    ) VALUES (?, ?, ?, ?, NULL)
  `)
  for (const [index, file] of files.entries()) {
    const durable = durableRoots[index]
    if (!durable || durable.itemId !== file.itemId) throw new V3TransportError('TRANSFER_INTERNAL_ERROR', 500)
    insert.run(transferId, file.itemId, file.contentRoot, durable.contentRoot)
  }
}

function updateCompletionItems(
  transferId: string,
  files: V3CompletionFile[],
  durableRoots: V3CompletionFile[]
) {
  const update = database.prepare(`
    UPDATE v3_transfer_completion_items
    SET requested_content_root = ?, durable_content_root = ?, actual_content_root = NULL
    WHERE transfer_id = ? AND item_id = ?
  `)
  for (const [index, file] of files.entries()) {
    const durable = durableRoots[index]
    if (!durable || durable.itemId !== file.itemId) throw new V3TransportError('TRANSFER_INTERNAL_ERROR', 500)
    update.run(file.contentRoot, durable.contentRoot, transferId, file.itemId)
  }
}

function storeActualRoots(transferId: string, actualFiles: V3CompletionFile[]) {
  const update = database.prepare(`
    UPDATE v3_transfer_completion_items
    SET actual_content_root = ?
    WHERE transfer_id = ? AND item_id = ?
  `)
  for (const file of actualFiles) {
    if (isCompletionFile(file) && isV3ContentRootHex(file.contentRoot)) {
      update.run(file.contentRoot, transferId, file.itemId)
    }
  }
}

function isCompletionFile(value: unknown): value is V3CompletionFile {
  return isRecord(value) && typeof value.itemId === 'string' && typeof value.contentRoot === 'string'
}

function transitionToCompleting(
  transferId: string,
  totalBytes: number,
  preserveVerifyingBytes: boolean
): V3TransferRow {
  database.prepare(`
    UPDATE v3_transfers
    SET status = 'completing', failure_code = NULL,
        verifying_bytes = CASE WHEN ? THEN verifying_bytes ELSE 0 END,
        verifying_total_bytes = ?, verifying_phase = 'idle',
        completion_attempt = completion_attempt + 1, revision = revision + 1, updated_at = ?
    WHERE transfer_id = ?
  `).run(preserveVerifyingBytes ? 1 : 0, totalBytes, Date.now(), transferId)
  return requireTransfer(transferId)
}

function markContentRootMismatch(transferId: string, totalBytes: number): V3TransferRow {
  database.prepare(`
    UPDATE v3_transfers
    SET status = 'failed', failure_code = 'CONTENT_ROOT_MISMATCH',
        verifying_bytes = 0, verifying_total_bytes = ?, verifying_phase = 'done',
        revision = revision + 1, updated_at = ?
    WHERE transfer_id = ?
  `).run(totalBytes, Date.now(), transferId)
  return requireTransfer(transferId)
}

function toCompletionVerificationPlan(
  transfer: V3TransferRow,
  items: V3TransferItemRow[]
): V3CompletionVerificationPlan {
  return {
    chunkSizeBytes: transfer.chunk_size_bytes,
    completionAttempt: transfer.completion_attempt,
    items: items.map((item) => ({itemId: item.item_id, sizeBytes: item.size_bytes})),
    transferId: transfer.transfer_id
  }
}

function isCurrentCompletionAttempt(transfer: V3TransferRow, completionAttempt: number) {
  return transfer.status === 'completing' && transfer.completion_attempt === completionAttempt
}

function assertVerificationProgress(
  verifyingBytes: number,
  verifyingTotalBytes: number,
  verifyingPhase: V3VerificationPhase,
  totalBytes: number
) {
  if (!Number.isSafeInteger(verifyingBytes) || verifyingBytes < 0 || verifyingBytes > totalBytes) {
    throw new V3TransportError('INVALID_VERIFICATION_PROGRESS', 400)
  }
  if (verifyingTotalBytes !== totalBytes) throw new V3TransportError('INVALID_VERIFICATION_PROGRESS', 400)
  if (!isVerificationPhase(verifyingPhase)) throw new V3TransportError('INVALID_VERIFICATION_PROGRESS', 400)
}

function isVerificationPhase(value: unknown): value is V3VerificationPhase {
  return value === 'idle' || value === 'reading' || value === 'hashing' || value === 'done'
}

function verificationPhaseRank(phase: V3VerificationPhase) {
  switch (phase) {
    case 'idle':
      return 0
    case 'reading':
      return 1
    case 'hashing':
      return 2
    case 'done':
      return 3
  }
}

function getStoredCreation(transferId: string): V3TransferCreation | null {
  const transfer = getTransfer(transferId)
  if (!transfer) return null
  return {
    chunkSizeBytes: transfer.chunk_size_bytes,
    items: getItems(transferId).map((item) => ({
      itemId: item.item_id,
      mimeType: item.mime_type,
      name: item.name,
      sizeBytes: item.size_bytes
    })),
    sourceDeviceId: transfer.source_device_id,
    transferId
  }
}

function getStoredChunk(transferId: string, itemId: string, chunkIndex: number): {byte_length: number; sha256: string} | null {
  const row = database.prepare(`
    SELECT byte_length, sha256 FROM v3_transfer_chunks
    WHERE transfer_id = ? AND item_id = ? AND chunk_index = ?
  `).get(transferId, itemId, chunkIndex) as {byte_length: number; sha256: string} | undefined
  return row ?? null
}

function getItemChunks(transferId: string, itemId: string): V3TransferChunkRow[] {
  return database.prepare(`
    SELECT item_id, chunk_index, byte_length, sha256
    FROM v3_transfer_chunks
    WHERE transfer_id = ? AND item_id = ?
    ORDER BY chunk_index
  `).all(transferId, itemId) as V3TransferChunkRow[]
}

function getCompletionItems(transferId: string): V3CompletionItemRow[] {
  return database.prepare(`
    SELECT c.item_id, c.requested_content_root, c.durable_content_root, c.actual_content_root
    FROM v3_transfer_completion_items c
    JOIN v3_transfer_items i ON i.transfer_id = c.transfer_id AND i.item_id = c.item_id
    WHERE c.transfer_id = ?
    ORDER BY i.item_ordinal
  `).all(transferId) as V3CompletionItemRow[]
}

function getTransfer(transferId: string): V3TransferRow | null {
  const row = database.prepare('SELECT * FROM v3_transfers WHERE transfer_id = ?').get(transferId) as V3TransferRow | undefined
  return row ?? null
}

function requireTransfer(transferId: string): V3TransferRow {
  const transfer = getTransfer(transferId)
  if (!transfer) throw new V3TransportError('TRANSFER_NOT_FOUND', 404)
  return transfer
}

function getItem(transferId: string, itemId: string): V3TransferItemRow | null {
  const row = database.prepare(`
    SELECT * FROM v3_transfer_items WHERE transfer_id = ? AND item_id = ?
  `).get(transferId, itemId) as V3TransferItemRow | undefined
  return row ?? null
}

function getItems(transferId: string): V3TransferItemRow[] {
  return database.prepare(`
    SELECT * FROM v3_transfer_items WHERE transfer_id = ? ORDER BY item_ordinal
  `).all(transferId) as V3TransferItemRow[]
}

function getTotalBytes(items: V3TransferItemRow[]) {
  const total = items.reduce((sum, item) => sum + item.size_bytes, 0)
  if (!Number.isSafeInteger(total)) throw new V3TransportError('TRANSFER_DURABLE_CONTENT_INVALID', 500)
  return total
}

function inTransaction<T>(operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original storage failure when SQLite has already ended the transaction.
    }
    throw error
  }
}

function sameCreation(left: V3TransferCreation, right: V3TransferCreation) {
  if (left.transferId !== right.transferId || left.sourceDeviceId !== right.sourceDeviceId || left.chunkSizeBytes !== right.chunkSizeBytes) {
    return false
  }
  if (left.items.length !== right.items.length) return false
  return left.items.every((item, index) => {
    const candidate = right.items[index]
    return candidate !== undefined
      && candidate.itemId === item.itemId
      && candidate.name === item.name
      && candidate.mimeType === item.mimeType
      && candidate.sizeBytes === item.sizeBytes
  })
}

function getWorkerRootDirectory(value: unknown): string {
  if (!isRecord(value) || typeof value.rootDirectory !== 'string' || value.rootDirectory.length === 0) {
    throw new Error('V3 transfer database worker requires a root directory.')
  }
  return value.rootDirectory
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isWorkerRequest(value: unknown): value is V3TransferWorkerRequest {
  return isRecord(value) && typeof value.id === 'number' && isRecord(value.payload) && typeof value.payload.type === 'string'
}

function serializeError(error: unknown): V3SerializedTransferError {
  if (error instanceof V3TransportError) {
    return {code: error.code, message: error.message, statusCode: error.statusCode}
  }
  return {
    code: 'TRANSFER_INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'V3 transfer database worker failed.',
    statusCode: 500
  }
}
