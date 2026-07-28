import * as SQLite from 'expo-sqlite'

import type {TransferFailureCode} from '@flowdrop/types'

import {applyV3TransferProjectionMigration} from './v3TransferProjectionMigration'
import {applyV3TextMessageMigration} from './v3TextMessageMigration'


const DATABASE_NAME = 'flowdrop.sqlite'
const PROJECTION_FLUSH_INTERVAL_MS = 100
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

export const CHUNK_DIGEST_MISMATCH = 'CHUNK_DIGEST_MISMATCH'

export type V3TransferStatus =
  | 'cancelled'
  | 'completed'
  | 'completing'
  | 'draft'
  | 'failed'
  | 'negotiating'
  | 'paused'
  | 'preparing'
  | 'queued'
  | 'recovering'
  | 'transferring'
  | 'verifying'
  | 'waiting_for_peer'

export type V3TransferFailureCode = TransferFailureCode | typeof CHUNK_DIGEST_MISMATCH | (string & {})

export type V3TransferPendingOperation = 'cancel' | 'pause' | 'resume'

export type V3RecoveryState = 'failed' | 'idle' | 'ready' | 'recovering'

export type V3VerifyingPhase = 'done' | 'hashing' | 'idle' | 'reading'

export type V3OutgoingTransferItem = {
  itemId: string
  mimeType: string
  name: string
  sizeBytes: number
  sourceUri: string
}

export type V3ChunkDigest = {
  confirmedRevision: number
  index: number
  itemId: string
  length: number
  sha256: string
}

export type V3ChunkDigestMismatch = {
  agent: Pick<V3ChunkDigest, 'length' | 'sha256'>
  detectedAt: number
  detectedRevision: number
  index: number
  itemId: string
  local: Pick<V3ChunkDigest, 'length' | 'sha256'>
}

export type V3OutgoingTransferTask = {
  chunkDigestMismatches: V3ChunkDigestMismatch[]
  chunkSizeBytes: number
  confirmedBytes: number
  confirmedRateBytesPerSecond: number
  createdAt: number
  failureCode?: V3TransferFailureCode
  isOptimistic: boolean
  /** Ephemeral native status-repair indicator; intentionally not persisted. */
  isRepairing?: boolean
  items: V3OutgoingTransferItem[]
  lastRemoteSyncAt?: number
  operationGeneration: number
  operationId: string
  peerAddress: string
  peerControlPort: number
  peerDeviceId: string
  pendingOperation?: V3TransferPendingOperation
  protocolVersion: 3
  recoveryManifestEntries: number
  recoveryManifestTotal: number
  recoveryState: V3RecoveryState
  remoteRevision: number
  sourceDeviceId: string
  status: V3TransferStatus
  submittedBytes: number
  totalBytes: number
  transferId: string
  updatedAt: number
  verifyingBytes: number
  verifyingPhase: V3VerifyingPhase
  verifyingTotalBytes: number
}

export type CreateV3OutgoingTransferInput = {
  chunkSizeBytes: number
  items: V3OutgoingTransferItem[]
  peerAddress: string
  peerControlPort: number
  peerDeviceId: string
  sourceDeviceId: string
  transferId: string
}

/**
 * Mirrors transferState/transferProgress/transferFailure metadata. It is
 * deliberately metadata-only: no file bytes cross into JavaScript.
 */
export type V3TransferProjectionUpdate = {
  confirmedBytes: number
  confirmedRateBytesPerSecond: number
  errorCode?: V3TransferFailureCode
  /** True only for the store's explicit control resolve/rollback writes. */
  isControlSettlement?: boolean
  isOptimistic?: boolean
  /** Ephemeral native status-repair indicator; intentionally not persisted. */
  isRepairing?: boolean
  lastRemoteSyncAt?: number
  operationGeneration: number
  operationId: string
  pendingOperation?: V3TransferPendingOperation | null
  recoveryManifestEntries: number
  recoveryManifestTotal: number
  recoveryState?: V3RecoveryState
  revision: number
  status: V3TransferStatus
  submittedBytes: number
  transferId: string
  verifyingBytes: number
  verifyingPhase: V3VerifyingPhase
  verifyingTotalBytes: number
}

export type V3ProjectionApplyResult = {
  applied: boolean
  ignoredReason?: 'non_retriable_failure' | 'optimistic_terminal' | 'pending_operation' | 'stale_revision' | 'terminal_state'
  revision: number
  transferId: string
}

export type V3DigestManifestReconciliation = {
  adoptedAgentDigests: number
  ignoredReason?: 'non_retriable_failure' | 'stale_revision'
  mismatches: V3ChunkDigestMismatch[]
  task: V3OutgoingTransferTask
}

type ProjectionRow = {
  chunk_size_bytes: number
  confirmed_bytes: number
  confirmed_rate_bps: number
  created_at: number
  failure_code: string | null
  is_optimistic: number
  last_remote_sync_at: number | null
  operation_generation: number
  operation_id: string
  peer_address: string
  peer_control_port: number
  peer_device_id: string
  pending_operation: string | null
  protocol_version: number
  recovery_manifest_entries: number
  recovery_manifest_total: number
  recovery_state: string
  remote_revision: number
  source_device_id: string
  status: string
  submitted_bytes: number
  total_bytes: number
  transfer_id: string
  updated_at: number
  verifying_bytes: number
  verifying_phase: string
  verifying_total_bytes: number
}

type ItemRow = {
  item_id: string
  mime_type: string
  name: string
  size_bytes: number
  source_uri: string
}

type DigestRow = {
  byte_length: number
  confirmed_at: number
  confirmed_revision: number
  chunk_index: number
  item_id: string
  sha256: string
}

type MismatchRow = {
  agent_byte_length: number
  agent_sha256: string
  chunk_index: number
  detected_at: number
  detected_revision: number
  item_id: string
  local_byte_length: number
  local_sha256: string
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null
let writeTail: Promise<void> = Promise.resolve()
let projectionFlushTimer: ReturnType<typeof setTimeout> | null = null
let pendingProjectionUpdates = new Map<string, V3TransferProjectionUpdate>()
let pendingProjectionFlush: Deferred<void> | null = null
let digestFlushTimer: ReturnType<typeof setTimeout> | null = null
let pendingDigestWrites: Array<{digests: V3ChunkDigest[]; transferId: string}> = []
let pendingDigestFlush: Deferred<void> | null = null

export async function createV3OutgoingTransfer(input: CreateV3OutgoingTransferInput): Promise<V3OutgoingTransferTask> {
  validateCreateInput(input)
  const totalBytes = input.items.reduce((total, item) => total + item.sizeBytes, 0)
  const now = Date.now()

  await enqueueWrite(async () => {
    const database = await getDatabase()
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO outgoing_transfer_v3_projection (
          transfer_id, source_device_id, peer_device_id, peer_address, peer_control_port,
          protocol_version, chunk_size_bytes, status, total_bytes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 3, ?, 'queued', ?, ?, ?)`,
        input.transferId,
        input.sourceDeviceId,
        input.peerDeviceId,
        input.peerAddress,
        input.peerControlPort,
        input.chunkSizeBytes,
        totalBytes,
        now,
        now
      )

      for (const [itemOrdinal, item] of input.items.entries()) {
        await transaction.runAsync(
          `INSERT INTO outgoing_transfer_v3_items (
            transfer_id, item_id, item_ordinal, name, mime_type, size_bytes, source_uri
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          input.transferId,
          item.itemId,
          itemOrdinal,
          item.name,
          item.mimeType,
          item.sizeBytes,
          item.sourceUri
        )
      }
    })
  })

  return requireV3OutgoingTransfer(input.transferId)
}

export async function getV3OutgoingTransfer(transferId: string): Promise<V3OutgoingTransferTask | null> {
  await waitForPersistedWrites()
  const database = await getDatabase()
  return loadV3OutgoingTransfer(database, transferId)
}

export async function requireV3OutgoingTransfer(transferId: string): Promise<V3OutgoingTransferTask> {
  const task = await getV3OutgoingTransfer(transferId)
  if (!task) throw new Error('TRANSFER_NOT_FOUND')
  return task
}

export async function listV3OutgoingTransfers(peerDeviceId?: string): Promise<V3OutgoingTransferTask[]> {
  await waitForPersistedWrites()
  const database = await getDatabase()
  const rows = peerDeviceId
    ? await database.getAllAsync<ProjectionRow>(
      `SELECT * FROM outgoing_transfer_v3_projection
       WHERE peer_device_id = ?
       ORDER BY updated_at DESC`,
      peerDeviceId
    )
    : await database.getAllAsync<ProjectionRow>(
      'SELECT * FROM outgoing_transfer_v3_projection ORDER BY updated_at DESC'
    )

  return Promise.all(rows.map((row) => hydrateV3OutgoingTransfer(database, row)))
}

/**
 * A JavaScript runtime cannot complete a control request that died with the
 * process. Before native recovery contacts the Agent, clear that local-only
 * optimistic marker and expose every recoverable task as recovering. The
 * Agent's revisioned snapshot remains the authority for its eventual state.
 */
export async function prepareV3OutgoingTransfersForRecovery(): Promise<V3OutgoingTransferTask[]> {
  await waitForPersistedWrites()

  const transferIds = await enqueueWrite(async () => {
    const database = await getDatabase()
    const rows = await database.getAllAsync<Pick<ProjectionRow,
      'failure_code' | 'is_optimistic' | 'pending_operation' | 'status' | 'transfer_id'>>(
      `SELECT transfer_id, status, failure_code, is_optimistic, pending_operation
       FROM outgoing_transfer_v3_projection`
    )
    // An optimistic cancel is a separate recovery path: it must first query
    // the Agent and finish that cancel, never recreate the transfer.
    const cancellationIds = rows
      .filter((row) => isPendingCancellationRow(row))
      .map((row) => row.transfer_id)
    const recoverableIds = rows
      .filter((row) => !isPendingCancellationRow(row) && isRecoveryCandidate(row))
      .map((row) => row.transfer_id)
    if (recoverableIds.length === 0) return cancellationIds

    const now = Date.now()
    await database.withExclusiveTransactionAsync(async (transaction) => {
      for (const transferId of recoverableIds) {
        await transaction.runAsync(
          `UPDATE outgoing_transfer_v3_projection
           SET status = 'recovering', pending_operation = NULL, is_optimistic = 0,
               recovery_state = 'recovering', recovery_manifest_entries = 0,
               recovery_manifest_total = 0, updated_at = ?
           WHERE transfer_id = ?`,
          now,
          transferId
        )
      }
    })
    return [...recoverableIds, ...cancellationIds]
  })

  return Promise.all(transferIds.map((transferId) => requireV3OutgoingTransfer(transferId)))
}

/**
 * Event handlers should call this without awaiting it. Updates for a transfer
 * are merged for 100 ms and then persisted in one asynchronous transaction.
 */
export function enqueueV3TransferProjectionUpdate(update: V3TransferProjectionUpdate): Promise<void> {
  validateProjectionUpdate(update)
  const current = pendingProjectionUpdates.get(update.transferId)
  pendingProjectionUpdates.set(update.transferId, current ? mergeProjectionUpdates(current, update) : update)
  return scheduleProjectionFlush()
}

export async function flushV3TransferProjectionUpdates(): Promise<V3ProjectionApplyResult[]> {
  if (projectionFlushTimer) {
    clearTimeout(projectionFlushTimer)
    projectionFlushTimer = null
  }

  const deferred = pendingProjectionFlush
  const updates = [...pendingProjectionUpdates.values()]
  pendingProjectionUpdates = new Map()
  pendingProjectionFlush = null
  if (updates.length === 0) {
    deferred?.resolve()
    return []
  }

  try {
    const results = await applyV3TransferProjectionUpdates(updates)
    deferred?.resolve()
    return results
  } catch (error) {
    deferred?.reject(error)
    throw error
  }
}

export async function applyV3TransferProjectionUpdate(update: V3TransferProjectionUpdate): Promise<V3ProjectionApplyResult> {
  const [result] = await applyV3TransferProjectionUpdates([update])
  return result
}

export async function applyV3TransferProjectionUpdates(
  updates: V3TransferProjectionUpdate[]
): Promise<V3ProjectionApplyResult[]> {
  if (updates.length === 0) return []
  updates.forEach(validateProjectionUpdate)

  return enqueueWrite(async () => {
    const database = await getDatabase()
    const results: V3ProjectionApplyResult[] = []
    await database.withExclusiveTransactionAsync(async (transaction) => {
      for (const update of updates) {
        const row = await transaction.getFirstAsync<ProjectionRow>(
          'SELECT * FROM outgoing_transfer_v3_projection WHERE transfer_id = ?',
          update.transferId
        )
        if (!row) throw new Error('TRANSFER_NOT_FOUND')
        results.push(await applyProjectionUpdate(transaction, row, update))
      }
    })
    return results
  })
}

export async function beginV3TransferPendingOperation(
  transferId: string,
  operation: V3TransferPendingOperation,
  optimisticStatus: Extract<V3TransferStatus, 'cancelled' | 'paused' | 'transferring'>
): Promise<V3OutgoingTransferTask> {
  await enqueueWrite(async () => {
    const database = await getDatabase()
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const row = await transaction.getFirstAsync<ProjectionRow>(
        'SELECT * FROM outgoing_transfer_v3_projection WHERE transfer_id = ?',
        transferId
      )
      if (!row) throw new Error('TRANSFER_NOT_FOUND')
      if (row.failure_code === CHUNK_DIGEST_MISMATCH) {
        throw new Error('TRANSFER_RECREATE_REQUIRED')
      }
      if (isTerminalStatus(asStatus(row.status))) throw new Error('TRANSFER_STATE_INVALID')

      await transaction.runAsync(
        `UPDATE outgoing_transfer_v3_projection
         SET pending_operation = ?, is_optimistic = 1, status = ?, updated_at = ?
         WHERE transfer_id = ?`,
        operation,
        optimisticStatus,
        Date.now(),
        transferId
      )
    })
  })

  return requireV3OutgoingTransfer(transferId)
}

/**
 * A successful Agent control response is authoritative. Passing the response
 * through the normal revision guard clears the local optimistic marker.
 */
export async function resolveV3TransferPendingOperation(
  transferId: string,
  operation: V3TransferPendingOperation,
  response: Pick<V3TransferProjectionUpdate, 'revision' | 'status'>
): Promise<V3ProjectionApplyResult> {
  const task = await requireV3OutgoingTransfer(transferId)
  if (task.pendingOperation && task.pendingOperation !== operation) {
    throw new Error('TRANSFER_OPERATION_SUPERSEDED')
  }

  return applyV3TransferProjectionUpdate({
    confirmedBytes: task.confirmedBytes,
    confirmedRateBytesPerSecond: task.confirmedRateBytesPerSecond,
    isControlSettlement: true,
    isOptimistic: false,
    operationGeneration: task.operationGeneration,
    operationId: task.operationId,
    pendingOperation: null,
    recoveryManifestEntries: task.recoveryManifestEntries,
    recoveryManifestTotal: task.recoveryManifestTotal,
    recoveryState: task.recoveryState,
    revision: response.revision,
    status: response.status,
    submittedBytes: task.submittedBytes,
    transferId,
    verifyingBytes: task.verifyingBytes,
    verifyingPhase: task.verifyingPhase,
    verifyingTotalBytes: task.verifyingTotalBytes
  })
}

export async function persistV3ConfirmedChunkDigests(
  transferId: string,
  digests: V3ChunkDigest[]
): Promise<void> {
  validateChunkDigests(digests)
  if (digests.length === 0) return
  if (pendingDigestWrites.length > 0) await flushV3ConfirmedChunkDigests()

  await enqueueWrite(async () => {
    const database = await getDatabase()
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await persistV3ConfirmedChunkDigestBatches(transaction, transferId, [digests])
    })
  })
}

/**
 * Coalesces consecutive durable-ACK digest events before SQLite work. The
 * returned promise is optional for event handlers; UI state must not wait on
 * it before rendering.
 */
export function enqueueV3ConfirmedChunkDigests(transferId: string, digests: V3ChunkDigest[]): Promise<void> {
  validateChunkDigests(digests)
  if (digests.length === 0) return Promise.resolve()
  pendingDigestWrites.push({digests, transferId})
  return scheduleDigestFlush()
}

export async function flushV3ConfirmedChunkDigests(): Promise<void> {
  if (digestFlushTimer) {
    clearTimeout(digestFlushTimer)
    digestFlushTimer = null
  }

  const deferred = pendingDigestFlush
  const writes = pendingDigestWrites
  pendingDigestWrites = []
  pendingDigestFlush = null
  if (writes.length === 0) {
    deferred?.resolve()
    return
  }

  try {
    await enqueueWrite(async () => {
      const database = await getDatabase()
      const batchesByTransfer = new Map<string, V3ChunkDigest[][]>()
      for (const write of writes) {
        const batches = batchesByTransfer.get(write.transferId) ?? []
        batches.push(write.digests)
        batchesByTransfer.set(write.transferId, batches)
      }
      await database.withExclusiveTransactionAsync(async (transaction) => {
        for (const [transferId, batches] of batchesByTransfer) {
          await persistV3ConfirmedChunkDigestBatches(transaction, transferId, batches)
        }
      })
    })
    deferred?.resolve()
  } catch (error) {
    deferred?.reject(error)
    throw error
  }
}

/**
 * Returns a metadata-only manifest in the exact shape expected by the Android
 * bridge's persistedChunkDigests config. It never reads file content.
 */
export async function loadV3ChunkDigestManifest(transferId: string): Promise<V3ChunkDigest[]> {
  await waitForPersistedWrites()
  const database = await getDatabase()
  const rows = await database.getAllAsync<DigestRow>(
    `SELECT * FROM outgoing_transfer_chunk_digests
     WHERE transfer_id = ?
     ORDER BY item_id ASC, chunk_index ASC`,
    transferId
  )
  return rows.map(toChunkDigest)
}

/**
 * Compares Agent-authoritative digest pages with local durable acknowledgements.
 * A differing digest or length is terminal and deliberately does not enqueue a
 * replacement chunk: the user must create a new transfer.
 */
export async function reconcileV3AgentChunkDigests(
  transferId: string,
  agentDigests: V3ChunkDigest[],
  remoteRevision: number
): Promise<V3DigestManifestReconciliation> {
  validateChunkDigests(agentDigests)
  validateNonNegativeSafeInteger(remoteRevision, 'remoteRevision')
  await waitForPersistedWrites()

  const reconciliation = await enqueueWrite(async () => {
    const database = await getDatabase()
    let adoptedAgentDigests = 0
    let ignoredReason: V3DigestManifestReconciliation['ignoredReason']
    let mismatches: V3ChunkDigestMismatch[] = []
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const task = await transaction.getFirstAsync<ProjectionRow>(
        'SELECT * FROM outgoing_transfer_v3_projection WHERE transfer_id = ?',
        transferId
      )
      if (!task) throw new Error('TRANSFER_NOT_FOUND')
      // Do not let an older native operation's mismatch diagnostics turn a
      // newer revision into failed. Same-revision mismatch evidence remains
      // valid and is retained below for the required failure details.
      if (remoteRevision < task.remote_revision) {
        ignoredReason = 'stale_revision'
        return
      }
      if (isTerminalStatus(asStatus(task.status)) && task.failure_code !== CHUNK_DIGEST_MISMATCH) {
        ignoredReason = 'stale_revision'
        return
      }
      await validateDigestItems(transaction, transferId, agentDigests)
      const localRows = await transaction.getAllAsync<DigestRow>(
        'SELECT * FROM outgoing_transfer_chunk_digests WHERE transfer_id = ?',
        transferId
      )
      const localByKey = new Map(localRows.map((digest) => [digestKey(digest.item_id, digest.chunk_index), digest]))
      const now = Date.now()

      mismatches = agentDigests.flatMap((agent) => {
        const local = localByKey.get(digestKey(agent.itemId, agent.index))
        if (!local || (local.byte_length === agent.length && local.sha256 === agent.sha256)) return []
        return [{
          agent: {length: agent.length, sha256: agent.sha256},
          detectedAt: now,
          detectedRevision: remoteRevision,
          index: agent.index,
          itemId: agent.itemId,
          local: {length: local.byte_length, sha256: local.sha256}
        }]
      })

      if (mismatches.length > 0) {
        // A native failure event can be projected before this reconciliation
        // reaches SQLite. Persist its evidence even when the task is already
        // failed, otherwise the required local/Agent digest diagnostics are
        // silently lost.
        await persistChunkDigestMismatches(transaction, task, mismatches)
        return
      }

      if (task.failure_code === CHUNK_DIGEST_MISMATCH) {
        ignoredReason = 'non_retriable_failure'
        return
      }

      for (const agent of agentDigests) {
        if (localByKey.has(digestKey(agent.itemId, agent.index))) continue
        await transaction.runAsync(
          `INSERT INTO outgoing_transfer_chunk_digests (
            transfer_id, item_id, chunk_index, byte_length, sha256, confirmed_revision, confirmed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          transferId,
          agent.itemId,
          agent.index,
          agent.length,
          agent.sha256,
          agent.confirmedRevision,
          now
        )
        adoptedAgentDigests += 1
      }
      await transaction.runAsync(
        `UPDATE outgoing_transfer_v3_projection
         SET remote_revision = ?, last_remote_sync_at = ?, updated_at = ?
         WHERE transfer_id = ?`,
        Math.max(task.remote_revision, remoteRevision),
        now,
        now,
        transferId
      )
    })

    return {adoptedAgentDigests, ignoredReason, mismatches}
  })

  const task = await requireV3OutgoingTransfer(transferId)
  return {
    ...reconciliation,
    mismatches: reconciliation.mismatches.length > 0 ? reconciliation.mismatches : task.chunkDigestMismatches,
    task
  }
}

export async function deleteV3OutgoingTransfer(transferId: string): Promise<void> {
  await waitForPersistedWrites()
  await enqueueWrite(async () => {
    const database = await getDatabase()
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync('DELETE FROM outgoing_transfer_chunk_digest_conflicts WHERE transfer_id = ?', transferId)
      await transaction.runAsync('DELETE FROM outgoing_transfer_chunk_digests WHERE transfer_id = ?', transferId)
      await transaction.runAsync('DELETE FROM outgoing_transfer_v3_items WHERE transfer_id = ?', transferId)
      await transaction.runAsync('DELETE FROM outgoing_transfer_v3_projection WHERE transfer_id = ?', transferId)
    })
  })
}

function scheduleProjectionFlush(): Promise<void> {
  if (!pendingProjectionFlush) {
    pendingProjectionFlush = createDeferred<void>()
    // A caller may intentionally fire-and-forget an event write. Keep the
    // rejection observed while still returning the same promise to callers
    // that need to await durability.
    void pendingProjectionFlush.promise.catch(() => undefined)
  }
  if (!projectionFlushTimer) {
    projectionFlushTimer = setTimeout(() => {
      void flushV3TransferProjectionUpdates().catch(() => undefined)
    }, PROJECTION_FLUSH_INTERVAL_MS)
  }
  return pendingProjectionFlush.promise
}

function scheduleDigestFlush(): Promise<void> {
  if (!pendingDigestFlush) {
    pendingDigestFlush = createDeferred<void>()
    void pendingDigestFlush.promise.catch(() => undefined)
  }
  if (!digestFlushTimer) {
    digestFlushTimer = setTimeout(() => {
      void flushV3ConfirmedChunkDigests().catch(() => undefined)
    }, PROJECTION_FLUSH_INTERVAL_MS)
  }
  return pendingDigestFlush.promise
}

async function waitForPersistedWrites(): Promise<void> {
  if (pendingProjectionUpdates.size > 0) await flushV3TransferProjectionUpdates()
  if (pendingDigestWrites.length > 0) await flushV3ConfirmedChunkDigests()
  await writeTail
}

async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = openMigratedDatabase()
  }
  try {
    return await databasePromise
  } catch (error) {
    databasePromise = null
    throw error
  }
}

/**
 * V3 metadata shares one async Expo SQLite connection so independent V3
 * repositories cannot race each other while applying migrations.
 */
export async function getV3TransferProjectionDatabase(): Promise<SQLite.SQLiteDatabase> {
  return getDatabase()
}

async function openMigratedDatabase(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME)
  await applyV3TransferProjectionMigration(database)
  await applyV3TextMessageMigration(database)
  return database
}

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeTail.then(operation, operation)
  writeTail = result.then(() => undefined, () => undefined)
  return result
}

async function applyProjectionUpdate(
  database: SQLite.SQLiteDatabase,
  current: ProjectionRow,
  update: V3TransferProjectionUpdate
): Promise<V3ProjectionApplyResult> {
  const currentStatus = asStatus(current.status)
  const nonRetriableFailure = current.failure_code === CHUNK_DIGEST_MISMATCH
  const authoritativeTerminal = isTerminalStatus(update.status) && update.isOptimistic !== true
  if (nonRetriableFailure && update.status !== 'failed') {
    return ignoredProjectionUpdate(current, 'non_retriable_failure')
  }
  if (update.revision < current.remote_revision) {
    return ignoredProjectionUpdate(current, 'stale_revision')
  }
  // A native progress/state event can have been emitted before the Agent
  // serialized a pause/resume/cancel request. Only the explicit local
  // settlement write, or a real terminal failure, may clear that optimistic
  // control state.
  if (
    hasPendingControlRow(current)
    && update.status !== 'failed'
    && !authoritativeTerminal
    && update.isControlSettlement !== true
  ) {
    return ignoredProjectionUpdate(current, 'pending_operation')
  }
  if (isTerminalStatus(currentStatus) && update.status !== currentStatus) {
    const isOptimisticTerminal = current.is_optimistic === 1 && current.pending_operation !== null
    const resolvesOptimisticTerminal = update.status === 'failed'
      || authoritativeTerminal
      || update.isControlSettlement === true
    if (!isOptimisticTerminal) return ignoredProjectionUpdate(current, 'terminal_state')
    if (!resolvesOptimisticTerminal) return ignoredProjectionUpdate(current, 'optimistic_terminal')
  }
  if (update.confirmedBytes > current.total_bytes) {
    throw new Error('INVALID_TRANSFER_PROGRESS')
  }

  const nextConfirmedBytes = Math.max(current.confirmed_bytes, update.confirmedBytes)
  const nextSubmittedBytes = Math.min(
    current.total_bytes,
    Math.max(current.submitted_bytes, update.submittedBytes, nextConfirmedBytes)
  )
  const nextRevision = Math.max(current.remote_revision, update.revision)
  const nextFailureCode = nonRetriableFailure
    ? CHUNK_DIGEST_MISMATCH
    : update.status === 'failed'
    ? update.errorCode ?? current.failure_code
    : null
  const nextRecoveryState = update.recoveryState ?? (update.status === 'recovering' ? 'recovering' : current.recovery_state)
  const startsRecoveryScan = isRecoveryScanStart(update)
  const clearsPendingControl = authoritativeTerminal || update.status === 'failed' || update.isControlSettlement === true
  const now = Date.now()

  await database.runAsync(
    `UPDATE outgoing_transfer_v3_projection
     SET status = ?, failure_code = ?, confirmed_bytes = ?, submitted_bytes = ?, confirmed_rate_bps = ?,
         remote_revision = ?, pending_operation = ?, is_optimistic = ?, operation_id = ?, operation_generation = ?,
         last_remote_sync_at = ?, recovery_state = ?, recovery_manifest_entries = ?, recovery_manifest_total = ?,
         verifying_bytes = ?, verifying_total_bytes = ?, verifying_phase = ?, updated_at = ?
     WHERE transfer_id = ?`,
    update.status,
    nextFailureCode,
    nextConfirmedBytes,
    nextSubmittedBytes,
    update.confirmedRateBytesPerSecond,
    nextRevision,
    clearsPendingControl ? null : update.pendingOperation === undefined ? current.pending_operation : update.pendingOperation,
    authoritativeTerminal ? 0 : update.isOptimistic === undefined ? current.is_optimistic : update.isOptimistic ? 1 : 0,
    update.operationId,
    update.operationGeneration,
    update.lastRemoteSyncAt ?? current.last_remote_sync_at ?? (update.revision > current.remote_revision ? now : null),
    nextRecoveryState,
    startsRecoveryScan ? update.recoveryManifestEntries : Math.max(current.recovery_manifest_entries, update.recoveryManifestEntries),
    startsRecoveryScan ? update.recoveryManifestTotal : Math.max(current.recovery_manifest_total, update.recoveryManifestTotal),
    Math.max(current.verifying_bytes, update.verifyingBytes),
    Math.max(current.verifying_total_bytes, update.verifyingTotalBytes),
    update.verifyingPhase,
    now,
    update.transferId
  )

  return {applied: true, revision: nextRevision, transferId: update.transferId}
}

function ignoredProjectionUpdate(
  current: ProjectionRow,
  ignoredReason: NonNullable<V3ProjectionApplyResult['ignoredReason']>
): V3ProjectionApplyResult {
  return {
    applied: false,
    ignoredReason,
    revision: current.remote_revision,
    transferId: current.transfer_id
  }
}

async function loadV3OutgoingTransfer(
  database: SQLite.SQLiteDatabase,
  transferId: string
): Promise<V3OutgoingTransferTask | null> {
  const row = await database.getFirstAsync<ProjectionRow>(
    'SELECT * FROM outgoing_transfer_v3_projection WHERE transfer_id = ?',
    transferId
  )
  return row ? hydrateV3OutgoingTransfer(database, row) : null
}

async function hydrateV3OutgoingTransfer(
  database: SQLite.SQLiteDatabase,
  row: ProjectionRow
): Promise<V3OutgoingTransferTask> {
  const [items, mismatchRows] = await Promise.all([
    database.getAllAsync<ItemRow>(
      `SELECT item_id, name, mime_type, size_bytes, source_uri
       FROM outgoing_transfer_v3_items
       WHERE transfer_id = ?
       ORDER BY item_ordinal ASC`,
      row.transfer_id
    ),
    database.getAllAsync<MismatchRow>(
      `SELECT item_id, chunk_index, local_byte_length, local_sha256, agent_byte_length, agent_sha256,
              detected_revision, detected_at
       FROM outgoing_transfer_chunk_digest_conflicts
       WHERE transfer_id = ?
       ORDER BY item_id ASC, chunk_index ASC`,
      row.transfer_id
    )
  ])

  return {
    chunkDigestMismatches: mismatchRows.map(toChunkDigestMismatch),
    chunkSizeBytes: row.chunk_size_bytes,
    confirmedBytes: row.confirmed_bytes,
    confirmedRateBytesPerSecond: row.confirmed_rate_bps,
    createdAt: row.created_at,
    failureCode: row.failure_code ?? undefined,
    isOptimistic: row.is_optimistic === 1,
    items: items.map((item) => ({
      itemId: item.item_id,
      mimeType: item.mime_type,
      name: item.name,
      sizeBytes: item.size_bytes,
      sourceUri: item.source_uri
    })),
    lastRemoteSyncAt: row.last_remote_sync_at ?? undefined,
    operationGeneration: row.operation_generation,
    operationId: row.operation_id,
    peerAddress: row.peer_address,
    peerControlPort: row.peer_control_port,
    peerDeviceId: row.peer_device_id,
    pendingOperation: toPendingOperation(row.pending_operation),
    protocolVersion: 3,
    recoveryManifestEntries: row.recovery_manifest_entries,
    recoveryManifestTotal: row.recovery_manifest_total,
    recoveryState: asRecoveryState(row.recovery_state),
    remoteRevision: row.remote_revision,
    sourceDeviceId: row.source_device_id,
    status: asStatus(row.status),
    submittedBytes: row.submitted_bytes,
    totalBytes: row.total_bytes,
    transferId: row.transfer_id,
    updatedAt: row.updated_at,
    verifyingBytes: row.verifying_bytes,
    verifyingPhase: asVerifyingPhase(row.verifying_phase),
    verifyingTotalBytes: row.verifying_total_bytes
  }
}

function mergeProjectionUpdates(
  current: V3TransferProjectionUpdate,
  incoming: V3TransferProjectionUpdate
): V3TransferProjectionUpdate {
  if (incoming.revision < current.revision) return current
  if (isRecoveryScanStart(incoming)) {
    return {
      ...incoming,
      confirmedBytes: Math.max(current.confirmedBytes, incoming.confirmedBytes),
      submittedBytes: Math.max(current.submittedBytes, incoming.submittedBytes),
      verifyingBytes: Math.max(current.verifyingBytes, incoming.verifyingBytes),
      verifyingTotalBytes: Math.max(current.verifyingTotalBytes, incoming.verifyingTotalBytes)
    }
  }
  if (isTerminalStatus(current.status) && incoming.status !== current.status) {
    const currentIsOptimisticCancel = current.status === 'cancelled'
      && current.isOptimistic === true
      && current.pendingOperation === 'cancel'
    const incomingIsAuthoritativeTerminal = isTerminalStatus(incoming.status) && incoming.isOptimistic !== true
    if (!currentIsOptimisticCancel || !incomingIsAuthoritativeTerminal) return current
  }
  if (
    current.isControlSettlement === true
    && incoming.isControlSettlement !== true
    && incoming.status !== 'failed'
    && incoming.revision <= current.revision
  ) {
    return {
      ...current,
      confirmedBytes: Math.max(current.confirmedBytes, incoming.confirmedBytes),
      recoveryManifestEntries: Math.max(current.recoveryManifestEntries, incoming.recoveryManifestEntries),
      recoveryManifestTotal: Math.max(current.recoveryManifestTotal, incoming.recoveryManifestTotal),
      submittedBytes: Math.max(current.submittedBytes, incoming.submittedBytes),
      verifyingBytes: Math.max(current.verifyingBytes, incoming.verifyingBytes),
      verifyingTotalBytes: Math.max(current.verifyingTotalBytes, incoming.verifyingTotalBytes)
    }
  }

  return {
    ...incoming,
    confirmedBytes: Math.max(current.confirmedBytes, incoming.confirmedBytes),
    recoveryManifestEntries: Math.max(current.recoveryManifestEntries, incoming.recoveryManifestEntries),
    recoveryManifestTotal: Math.max(current.recoveryManifestTotal, incoming.recoveryManifestTotal),
    submittedBytes: Math.max(current.submittedBytes, incoming.submittedBytes),
    verifyingBytes: Math.max(current.verifyingBytes, incoming.verifyingBytes),
    verifyingTotalBytes: Math.max(current.verifyingTotalBytes, incoming.verifyingTotalBytes)
  }
}

function validateCreateInput(input: CreateV3OutgoingTransferInput) {
  validateIdentifier(input.transferId, 'transferId')
  validateIdentifier(input.sourceDeviceId, 'sourceDeviceId')
  validateIdentifier(input.peerDeviceId, 'peerDeviceId')
  validateNonNegativeSafeInteger(input.chunkSizeBytes, 'chunkSizeBytes')
  if (input.chunkSizeBytes === 0) throw new Error('INVALID_CHUNK_SIZE')
  if (!Number.isInteger(input.peerControlPort) || input.peerControlPort < 1 || input.peerControlPort > 65_535) {
    throw new Error('INVALID_PEER_CONTROL_PORT')
  }
  if (!input.peerAddress.trim()) throw new Error('INVALID_PEER_ADDRESS')
  if (input.items.length === 0) throw new Error('TRANSFER_ITEMS_REQUIRED')

  const itemIds = new Set<string>()
  let totalBytes = 0
  for (const item of input.items) {
    validateIdentifier(item.itemId, 'itemId')
    if (!itemIds.add(item.itemId)) throw new Error('DUPLICATE_ITEM_ID')
    if (!item.name.trim() || !item.mimeType.trim() || !item.sourceUri.trim()) throw new Error('INVALID_TRANSFER_ITEM')
    validateNonNegativeSafeInteger(item.sizeBytes, 'item.sizeBytes')
    totalBytes += item.sizeBytes
    if (totalBytes > MAX_SAFE_INTEGER) throw new Error('INVALID_TOTAL_BYTES')
  }
}

function validateProjectionUpdate(update: V3TransferProjectionUpdate) {
  validateIdentifier(update.transferId, 'transferId')
  validateNonNegativeSafeInteger(update.revision, 'revision')
  validateNonNegativeSafeInteger(update.confirmedBytes, 'confirmedBytes')
  validateNonNegativeSafeInteger(update.submittedBytes, 'submittedBytes')
  validateNonNegativeSafeInteger(update.recoveryManifestEntries, 'recoveryManifestEntries')
  validateNonNegativeSafeInteger(update.recoveryManifestTotal, 'recoveryManifestTotal')
  validateNonNegativeSafeInteger(update.verifyingBytes, 'verifyingBytes')
  validateNonNegativeSafeInteger(update.verifyingTotalBytes, 'verifyingTotalBytes')
  validateNonNegativeSafeInteger(update.operationGeneration, 'operationGeneration')
  if (!Number.isFinite(update.confirmedRateBytesPerSecond) || update.confirmedRateBytesPerSecond < 0) {
    throw new Error('INVALID_CONFIRMED_RATE')
  }
  if (!isStatus(update.status)) throw new Error('INVALID_TRANSFER_STATUS')
  if (!isVerifyingPhase(update.verifyingPhase)) throw new Error('INVALID_VERIFYING_PHASE')
  if (update.recoveryManifestEntries > update.recoveryManifestTotal) throw new Error('INVALID_RECOVERY_MANIFEST')
  if (update.recoveryState && !isRecoveryState(update.recoveryState)) throw new Error('INVALID_RECOVERY_STATE')
  if (update.pendingOperation !== undefined && update.pendingOperation !== null && !isPendingOperation(update.pendingOperation)) {
    throw new Error('INVALID_PENDING_OPERATION')
  }
}

function validateChunkDigests(digests: V3ChunkDigest[]) {
  const seen = new Set<string>()
  for (const digest of digests) {
    validateIdentifier(digest.itemId, 'itemId')
    validateNonNegativeSafeInteger(digest.index, 'index')
    validateNonNegativeSafeInteger(digest.length, 'length')
    validateNonNegativeSafeInteger(digest.confirmedRevision, 'confirmedRevision')
    if (!/^[0-9a-f]{64}$/.test(digest.sha256)) throw new Error('INVALID_CHUNK_DIGEST')
    const key = digestKey(digest.itemId, digest.index)
    if (!seen.add(key)) throw new Error('DUPLICATE_CHUNK_DIGEST')
  }
}

async function persistV3ConfirmedChunkDigestBatches(
  database: SQLite.SQLiteDatabase,
  transferId: string,
  batches: V3ChunkDigest[][]
): Promise<void> {
  const task = await database.getFirstAsync<ProjectionRow>(
    'SELECT * FROM outgoing_transfer_v3_projection WHERE transfer_id = ?',
    transferId
  )
  if (!task) throw new Error('TRANSFER_NOT_FOUND')
  if (task.failure_code === CHUNK_DIGEST_MISMATCH) return

  const digests = batches.flat()
  await validateDigestItems(database, transferId, digests)
  const existing = await database.getAllAsync<DigestRow>(
    'SELECT * FROM outgoing_transfer_chunk_digests WHERE transfer_id = ?',
    transferId
  )
  const existingByKey = new Map(existing.map((digest) => [digestKey(digest.item_id, digest.chunk_index), digest]))

  for (const batch of batches) {
    const now = Date.now()
    const mismatches = batch.flatMap((digest) => {
      const prior = existingByKey.get(digestKey(digest.itemId, digest.index))
      if (!prior || (prior.byte_length === digest.length && prior.sha256 === digest.sha256)) return []
      return [{
        agent: {length: digest.length, sha256: digest.sha256},
        detectedAt: now,
        detectedRevision: digest.confirmedRevision,
        index: digest.index,
        itemId: digest.itemId,
        local: {length: prior.byte_length, sha256: prior.sha256}
      }]
    })
    if (mismatches.length > 0) {
      await persistChunkDigestMismatches(database, task, mismatches)
      return
    }

    for (const digest of batch) {
      const key = digestKey(digest.itemId, digest.index)
      if (existingByKey.has(key)) continue
      await database.runAsync(
        `INSERT INTO outgoing_transfer_chunk_digests (
          transfer_id, item_id, chunk_index, byte_length, sha256, confirmed_revision, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        transferId,
        digest.itemId,
        digest.index,
        digest.length,
        digest.sha256,
        digest.confirmedRevision,
        now
      )
      existingByKey.set(key, {
        byte_length: digest.length,
        confirmed_at: now,
        confirmed_revision: digest.confirmedRevision,
        chunk_index: digest.index,
        item_id: digest.itemId,
        sha256: digest.sha256
      })
    }
  }
}

async function validateDigestItems(
  database: SQLite.SQLiteDatabase,
  transferId: string,
  digests: V3ChunkDigest[]
): Promise<void> {
  if (digests.length === 0) return
  const rows = await database.getAllAsync<{item_id: string}>(
    'SELECT item_id FROM outgoing_transfer_v3_items WHERE transfer_id = ?',
    transferId
  )
  const itemIds = new Set(rows.map((row) => row.item_id))
  if (digests.some((digest) => !itemIds.has(digest.itemId))) {
    throw new Error('TRANSFER_ITEM_NOT_FOUND')
  }
}

async function persistChunkDigestMismatches(
  database: SQLite.SQLiteDatabase,
  task: ProjectionRow,
  mismatches: V3ChunkDigestMismatch[]
): Promise<void> {
  for (const mismatch of mismatches) {
    await database.runAsync(
      `INSERT INTO outgoing_transfer_chunk_digest_conflicts (
        transfer_id, item_id, chunk_index, local_byte_length, local_sha256,
        agent_byte_length, agent_sha256, detected_revision, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transfer_id, item_id, chunk_index) DO UPDATE SET
        local_byte_length = excluded.local_byte_length,
        local_sha256 = excluded.local_sha256,
        agent_byte_length = excluded.agent_byte_length,
        agent_sha256 = excluded.agent_sha256,
        detected_revision = excluded.detected_revision,
        detected_at = excluded.detected_at`,
      task.transfer_id,
      mismatch.itemId,
      mismatch.index,
      mismatch.local.length,
      mismatch.local.sha256,
      mismatch.agent.length,
      mismatch.agent.sha256,
      mismatch.detectedRevision,
      mismatch.detectedAt
    )
  }
  const remoteRevision = Math.max(
    task.remote_revision,
    ...mismatches.map((mismatch) => mismatch.detectedRevision)
  )
  const now = Date.now()
  await database.runAsync(
    `UPDATE outgoing_transfer_v3_projection
     SET status = 'failed', failure_code = ?, pending_operation = NULL,
         is_optimistic = 0, remote_revision = ?, last_remote_sync_at = ?, updated_at = ?
     WHERE transfer_id = ?`,
    CHUNK_DIGEST_MISMATCH,
    remoteRevision,
    now,
    now,
    task.transfer_id
  )
}

function validateIdentifier(value: string, field: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`INVALID_${field.toUpperCase()}`)
}

function validateNonNegativeSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_${field.toUpperCase()}`)
}

function digestKey(itemId: string, index: number) {
  return `${itemId}\u0000${index}`
}

function toChunkDigest(row: DigestRow): V3ChunkDigest {
  return {
    confirmedRevision: row.confirmed_revision,
    index: row.chunk_index,
    itemId: row.item_id,
    length: row.byte_length,
    sha256: row.sha256
  }
}

function toChunkDigestMismatch(row: MismatchRow): V3ChunkDigestMismatch {
  return {
    agent: {length: row.agent_byte_length, sha256: row.agent_sha256},
    detectedAt: row.detected_at,
    detectedRevision: row.detected_revision,
    index: row.chunk_index,
    itemId: row.item_id,
    local: {length: row.local_byte_length, sha256: row.local_sha256}
  }
}

function isTerminalStatus(status: V3TransferStatus) {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function isRecoveryCandidate(
  row: Pick<ProjectionRow, 'failure_code' | 'is_optimistic' | 'pending_operation' | 'status'>
): boolean {
  const status = asStatus(row.status)
  // A durable paused state is already the desired cross-process state. Only
  // recover it when the process died while its pause command was unresolved.
  if (status === 'paused' && !hasPendingControlRow(row)) return false
  return !isTerminalStatus(status)
}

function isPendingCancellationRow(
  row: Pick<ProjectionRow, 'failure_code' | 'is_optimistic' | 'pending_operation' | 'status'>
): boolean {
  return asStatus(row.status) === 'cancelled'
    && row.is_optimistic === 1
    && row.pending_operation === 'cancel'
    && row.failure_code !== CHUNK_DIGEST_MISMATCH
}

function isRecoveryScanStart(update: V3TransferProjectionUpdate): boolean {
  return update.status === 'recovering'
    && update.recoveryState === 'recovering'
    && update.isOptimistic === true
}

function hasPendingControlRow(row: Pick<ProjectionRow, 'is_optimistic' | 'pending_operation'>) {
  return row.is_optimistic === 1 && row.pending_operation !== null
}

function isStatus(value: string): value is V3TransferStatus {
  return [
    'cancelled', 'completed', 'completing', 'draft', 'failed', 'negotiating', 'paused', 'preparing', 'queued',
    'recovering', 'transferring', 'verifying', 'waiting_for_peer'
  ].includes(value)
}

function asStatus(value: string): V3TransferStatus {
  if (!isStatus(value)) throw new Error('INVALID_PERSISTED_TRANSFER_STATUS')
  return value
}

function isRecoveryState(value: string): value is V3RecoveryState {
  return value === 'failed' || value === 'idle' || value === 'ready' || value === 'recovering'
}

function asRecoveryState(value: string): V3RecoveryState {
  if (!isRecoveryState(value)) return 'idle'
  return value
}

function isVerifyingPhase(value: string): value is V3VerifyingPhase {
  return value === 'done' || value === 'hashing' || value === 'idle' || value === 'reading'
}

function asVerifyingPhase(value: string): V3VerifyingPhase {
  if (!isVerifyingPhase(value)) return 'idle'
  return value
}

function isPendingOperation(value: string): value is V3TransferPendingOperation {
  return value === 'cancel' || value === 'pause' || value === 'resume'
}

function toPendingOperation(value: string | null): V3TransferPendingOperation | undefined {
  return value && isPendingOperation(value) ? value : undefined
}

type Deferred<T> = {
  promise: Promise<T>
  reject(error: unknown): void
  resolve(value: T): void
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return {promise, reject, resolve}
}
