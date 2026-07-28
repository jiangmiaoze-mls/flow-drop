import {create} from 'zustand/react'

import {
  CHUNK_DIGEST_MISMATCH,
  beginV3TransferPendingOperation,
  createV3OutgoingTransfer,
  deleteV3OutgoingTransfer,
  enqueueV3ConfirmedChunkDigests,
  enqueueV3TransferProjectionUpdate,
  flushV3ConfirmedChunkDigests,
  flushV3TransferProjectionUpdates,
  getV3OutgoingTransfer,
  listV3OutgoingTransfers,
  loadV3ChunkDigestManifest,
  prepareV3OutgoingTransfersForRecovery,
  reconcileV3AgentChunkDigests,
  resolveV3TransferPendingOperation,
  type CreateV3OutgoingTransferInput,
  type V3ChunkDigest,
  type V3DigestManifestReconciliation,
  type V3OutgoingTransferTask,
  type V3TransferPendingOperation,
  type V3TransferProjectionUpdate,
  type V3TransferStatus
} from '@/storage/v3TransferProjectionRepository'


type V3TransferProjectionState = {
  applyNativeProjection: (update: V3TransferProjectionUpdate) => boolean
  beginPendingOperation: (
    transferId: string,
    operation: V3TransferPendingOperation,
    optimisticStatus: Extract<V3TransferStatus, 'cancelled' | 'paused' | 'transferring'>
  ) => Promise<V3OutgoingTransferTask>
  createTransfer: (input: CreateV3OutgoingTransferInput) => Promise<V3OutgoingTransferTask>
  deleteTransfer: (transferId: string) => Promise<void>
  flushPersistence: () => Promise<void>
  hydrateAll: () => Promise<void>
  hydratePeer: (peerDeviceId: string) => Promise<void>
  prepareForNativeRecovery: () => Promise<V3OutgoingTransferTask[]>
  enqueueConfirmedChunkDigests: (transferId: string, digests: V3ChunkDigest[]) => void
  reconcileAgentChunkDigests: (
    transferId: string,
    digests: V3ChunkDigest[],
    revision: number
  ) => Promise<V3DigestManifestReconciliation>
  refreshTransfer: (transferId: string) => Promise<V3OutgoingTransferTask | null>
  rollbackPendingOperation: (
    transferId: string,
    operation: V3TransferPendingOperation,
    fallbackStatus: V3TransferStatus
  ) => void
  resolvePendingOperation: (
    transferId: string,
    operation: V3TransferPendingOperation,
    response: Pick<V3TransferProjectionUpdate, 'revision' | 'status'>
  ) => Promise<void>
  tasksById: Record<string, V3OutgoingTransferTask>
}

/**
 * The React-facing V3 transfer source of truth. Native events first update this
 * store synchronously; SQLite is an asynchronous recovery projection only.
 */
export const useV3TransferProjectionStore = create<V3TransferProjectionState>((set, get) => ({
  tasksById: {},

  applyNativeProjection: (update) => {
    let applied = false
    const persistedUpdate = {value: null as V3TransferProjectionUpdate | null}
    set((state) => {
      const current = state.tasksById[update.transferId]
      if (!current) return state

      const normalizedUpdate = normalizeNativeProjection(current, update)
      if (shouldIgnoreNativeProjection(current, normalizedUpdate)) return state

      applied = true
      persistedUpdate.value = normalizedUpdate
      return {
        tasksById: {
          ...state.tasksById,
          [update.transferId]: mergeNativeProjection(current, normalizedUpdate)
        }
      }
    })

    if (applied && persistedUpdate.value) {
      const updateForPersistence = persistedUpdate.value
      // The repository coalesces these writes. A persistence failure must never
      // replace a newer in-memory event with an older recovery snapshot.
      void enqueueV3TransferProjectionUpdate(updateForPersistence).catch(() => {
        console.warn('Unable to persist the V3 transfer projection.', updateForPersistence.transferId)
      })
    }
    return applied
  },

  beginPendingOperation: async (transferId, operation, optimisticStatus) => {
    const current = get().tasksById[transferId]
    if (!current) throw new Error('TRANSFER_NOT_FOUND')
    if (current.failureCode === CHUNK_DIGEST_MISMATCH) throw new Error('TRANSFER_RECREATE_REQUIRED')

    const optimistic = {
      ...current,
      isOptimistic: true,
      pendingOperation: operation,
      status: optimisticStatus,
      updatedAt: Date.now()
    }
    set((state) => ({
      tasksById: {...state.tasksById, [transferId]: optimistic}
    }))

    try {
      const persisted = await beginV3TransferPendingOperation(transferId, operation, optimisticStatus)
      set((state) => ({
        tasksById: state.tasksById[transferId]
          ? {
            ...state.tasksById,
            [transferId]: mergePersistedTask(state.tasksById[transferId], persisted)
          }
          : state.tasksById
      }))
      return persisted
    } catch (error) {
      set((state) => {
        const latest = state.tasksById[transferId]
        if (!latest || latest.pendingOperation !== operation || latest.remoteRevision > current.remoteRevision) return state
        return {tasksById: {...state.tasksById, [transferId]: current}}
      })
      throw error
    }
  },

  createTransfer: async (input) => {
    const task = await createV3OutgoingTransfer(input)
    set((state) => ({
      tasksById: {
        ...state.tasksById,
        [task.transferId]: state.tasksById[task.transferId]
          ? mergePersistedTask(state.tasksById[task.transferId], task)
          : task
      }
    }))
    return task
  },

  deleteTransfer: async (transferId) => {
    const task = get().tasksById[transferId]
    if (!task) return
    if (!isTerminalStatus(task.status)) throw new Error('TRANSFER_STATE_INVALID')

    await deleteV3OutgoingTransfer(transferId)
    set((state) => {
      if (!state.tasksById[transferId]) return state
      const tasksById = {...state.tasksById}
      delete tasksById[transferId]
      return {tasksById}
    })
  },

  flushPersistence: async () => {
    await Promise.all([
      flushV3TransferProjectionUpdates(),
      flushV3ConfirmedChunkDigests()
    ])
  },

  hydrateAll: async () => {
    const tasks = await listV3OutgoingTransfers()
    set((state) => ({
      tasksById: mergePersistedTasks(state.tasksById, tasks)
    }))
  },

  hydratePeer: async (peerDeviceId) => {
    const tasks = await listV3OutgoingTransfers(peerDeviceId)
    set((state) => {
      return {
        tasksById: mergePersistedTasks(state.tasksById, tasks)
      }
    })
  },

  prepareForNativeRecovery: async () => {
    const tasks = await prepareV3OutgoingTransfersForRecovery()
    set((state) => {
      const tasksById = {...state.tasksById}
      for (const persisted of tasks) {
        const current = tasksById[persisted.transferId]
        if (isPendingCancellation(persisted)) {
          // A process death between optimistic UI and Agent acknowledgement
          // must retain the cancel intent. The native runtime reconciles it
          // with GET status + cancel, never with a V3 create request.
          tasksById[persisted.transferId] = current
            ? mergePersistedTask(current, persisted)
            : persisted
          continue
        }
        // Recovery preparation is a deliberate local transition, so an equal
        // Agent revision must still show recovering before its queued native
        // start runs. Never overwrite a newer event or a confirmed terminal.
        if (
          current
          && (
            current.remoteRevision > persisted.remoteRevision
            || (isTerminalStatus(current.status) && !current.isOptimistic)
          )
        ) continue
        tasksById[persisted.transferId] = current
          ? {
            ...mergePersistedTask(current, persisted),
            isOptimistic: false,
            pendingOperation: undefined,
            recoveryManifestEntries: 0,
            recoveryManifestTotal: 0,
            recoveryState: 'recovering',
            status: 'recovering'
          }
          : persisted
      }
      return {tasksById}
    })
    return tasks
  },

  enqueueConfirmedChunkDigests: (transferId, digests) => {
    void enqueueV3ConfirmedChunkDigests(transferId, digests).catch(() => {
      console.warn('Unable to persist V3 chunk digests.', transferId)
    })
  },

  reconcileAgentChunkDigests: async (transferId, digests, revision) => {
    const result = await reconcileV3AgentChunkDigests(transferId, digests, revision)
    set((state) => {
      const latest = state.tasksById[transferId]
      return {
        tasksById: {
          ...state.tasksById,
          [transferId]: latest ? mergePersistedTask(latest, result.task) : result.task
        }
      }
    })
    return result
  },

  refreshTransfer: async (transferId) => {
    const task = await getV3OutgoingTransfer(transferId)
    set((state) => {
      if (task) {
        const current = state.tasksById[transferId]
        return {
          tasksById: {
            ...state.tasksById,
            [transferId]: current ? mergePersistedTask(current, task) : task
          }
        }
      }
      // An absent SQLite row may be an older recovery snapshot while the
      // native controller is still actively projecting this transfer.
      return state
    })
    return task
  },

  rollbackPendingOperation: (transferId, operation, fallbackStatus) => {
    let update: V3TransferProjectionUpdate | null = null
    set((state) => {
      const current = state.tasksById[transferId]
      if (
        !current
        || current.pendingOperation !== operation
        || !current.isOptimistic
        || (
          isTerminalStatus(current.status)
          && !(current.status === 'cancelled' && current.pendingOperation === 'cancel')
        )
      ) return state
      const restored = {
        ...current,
        isOptimistic: false,
        pendingOperation: undefined,
        status: fallbackStatus,
        updatedAt: Date.now()
      }
      update = toProjectionUpdate(restored, null, true)
      return {tasksById: {...state.tasksById, [transferId]: restored}}
    })
    if (update) {
      void enqueueV3TransferProjectionUpdate(update).catch(() => {
        console.warn('Unable to roll back the V3 transfer projection.', transferId)
      })
    }
  },

  resolvePendingOperation: async (transferId, operation, response) => {
    try {
      await resolveV3TransferPendingOperation(transferId, operation, response)
    } catch (error) {
      // The Agent response is already authoritative. Do not strand the UI in
      // an optimistic control state solely because this SQLite settlement
      // failed; retain it in memory and enqueue an idempotent repair write.
      let repairUpdate: V3TransferProjectionUpdate | null = null
      set((state) => {
        const current = state.tasksById[transferId]
        if (
          !current
          || current.pendingOperation !== operation
          || current.remoteRevision > response.revision
        ) return state
        const settled = {
          ...current,
          isOptimistic: false,
          pendingOperation: undefined,
          remoteRevision: response.revision,
          status: response.status,
          updatedAt: Date.now()
        }
        repairUpdate = toProjectionUpdate(settled, null, true)
        return {tasksById: {...state.tasksById, [transferId]: settled}}
      })
      if (repairUpdate) {
        void enqueueV3TransferProjectionUpdate(repairUpdate).catch(() => {
          console.warn('Unable to repair a settled V3 transfer control projection.', transferId)
        })
      }
      throw error
    }
    set((state) => {
      const current = state.tasksById[transferId]
      if (
        !current
        || current.pendingOperation !== operation
        || current.remoteRevision > response.revision
      ) {
        return state
      }
      return {
        tasksById: {
          ...state.tasksById,
          [transferId]: {
            ...current,
            isOptimistic: false,
            pendingOperation: undefined,
            remoteRevision: response.revision,
            status: response.status,
            updatedAt: Date.now()
          }
        }
      }
    })
  }
}))

export {loadV3ChunkDigestManifest}

function shouldIgnoreNativeProjection(task: V3OutgoingTransferTask, update: V3TransferProjectionUpdate) {
  if (task.failureCode === CHUNK_DIGEST_MISMATCH && update.status !== 'failed') return true
  if (update.revision < task.remoteRevision) return true
  const authoritativeTerminal = isTerminalStatus(update.status) && update.isOptimistic !== true
  // Controls are optimistic until their Agent response is explicitly resolved
  // or rolled back. Native state/progress events may have been emitted before
  // that request crossed the Agent's per-transfer queue, so they cannot settle
  // the local operation. A real failure remains terminal and is allowed through.
  if (hasPendingControl(task) && update.status !== 'failed' && !authoritativeTerminal) return true
  if (!isTerminalStatus(task.status) || update.status === task.status) return false
  return !(
    task.isOptimistic
      && task.pendingOperation === 'cancel'
      && (
        authoritativeTerminal
        || update.status === 'failed'
        || update.isControlSettlement === true
      )
  )
}

function mergeNativeProjection(
  task: V3OutgoingTransferTask,
  update: V3TransferProjectionUpdate
): V3OutgoingTransferTask {
  const nextStatus = update.status
  const isFailure = nextStatus === 'failed'
  const authoritativeTerminal = isTerminalStatus(nextStatus) && update.isOptimistic !== true
  const startsRecoveryScan = isRecoveryScanStart(update)
  return {
    ...task,
    confirmedBytes: Math.min(task.totalBytes, Math.max(task.confirmedBytes, update.confirmedBytes)),
    confirmedRateBytesPerSecond: update.confirmedRateBytesPerSecond,
    failureCode: task.failureCode === CHUNK_DIGEST_MISMATCH
      ? CHUNK_DIGEST_MISMATCH
      : isFailure ? update.errorCode ?? task.failureCode : undefined,
    isOptimistic: isFailure || authoritativeTerminal ? false : update.isOptimistic ?? task.isOptimistic,
    isRepairing: update.isRepairing ?? task.isRepairing,
    lastRemoteSyncAt: update.lastRemoteSyncAt
      ?? (update.revision > task.remoteRevision ? Date.now() : task.lastRemoteSyncAt),
    operationGeneration: update.operationGeneration,
    operationId: update.operationId,
    pendingOperation: isFailure || authoritativeTerminal
      ? undefined
      : update.pendingOperation === undefined ? task.pendingOperation : update.pendingOperation ?? undefined,
    recoveryManifestEntries: startsRecoveryScan
      ? update.recoveryManifestEntries
      : Math.max(task.recoveryManifestEntries, update.recoveryManifestEntries),
    recoveryManifestTotal: startsRecoveryScan
      ? update.recoveryManifestTotal
      : Math.max(task.recoveryManifestTotal, update.recoveryManifestTotal),
    recoveryState: update.recoveryState ?? (nextStatus === 'recovering' ? 'recovering' : task.recoveryState),
    remoteRevision: Math.max(task.remoteRevision, update.revision),
    status: nextStatus,
    submittedBytes: Math.min(task.totalBytes, Math.max(task.submittedBytes, update.submittedBytes, update.confirmedBytes)),
    updatedAt: Date.now(),
    verifyingBytes: Math.max(task.verifyingBytes, update.verifyingBytes),
    verifyingPhase: update.verifyingPhase,
    verifyingTotalBytes: Math.max(task.verifyingTotalBytes, update.verifyingTotalBytes)
  }
}

function normalizeNativeProjection(
  task: V3OutgoingTransferTask,
  update: V3TransferProjectionUpdate
): V3TransferProjectionUpdate {
  const confirmedBytes = Math.min(task.totalBytes, update.confirmedBytes)
  return confirmedBytes === update.confirmedBytes ? update : {...update, confirmedBytes}
}

function mergePersistedTasks(
  currentTasks: Record<string, V3OutgoingTransferTask>,
  persistedTasks: V3OutgoingTransferTask[]
) {
  const merged = {...currentTasks}
  for (const persisted of persistedTasks) {
    const current = merged[persisted.transferId]
    merged[persisted.transferId] = current ? mergePersistedTask(current, persisted) : persisted
  }
  return merged
}

/**
 * SQLite is a recovery projection, not an event source. Preserve an in-memory
 * terminal or pending-control task even when a page hydration obtains an older
 * disk snapshot, while still adopting monotonic durable counters and diagnostics.
 */
function mergePersistedTask(
  current: V3OutgoingTransferTask,
  persisted: V3OutgoingTransferTask
): V3OutgoingTransferTask {
  const hasChunkDigestMismatch = current.failureCode === CHUNK_DIGEST_MISMATCH
    || persisted.failureCode === CHUNK_DIGEST_MISMATCH
  const usePersistedState = !hasChunkDigestMismatch
    && !isTerminalStatus(current.status)
    && !hasPendingControl(current)
    && persisted.remoteRevision > current.remoteRevision
  const stateSource = usePersistedState ? persisted : current
  const totalBytes = current.totalBytes
  const status = hasChunkDigestMismatch ? 'failed' : stateSource.status

  return {
    ...current,
    chunkDigestMismatches: mergeChunkDigestMismatches(current.chunkDigestMismatches, persisted.chunkDigestMismatches),
    confirmedBytes: Math.min(totalBytes, Math.max(current.confirmedBytes, persisted.confirmedBytes)),
    confirmedRateBytesPerSecond: stateSource.confirmedRateBytesPerSecond,
    failureCode: hasChunkDigestMismatch
      ? CHUNK_DIGEST_MISMATCH
      : status === 'failed' ? stateSource.failureCode : undefined,
    isOptimistic: hasChunkDigestMismatch ? false : stateSource.isOptimistic,
    isRepairing: current.isRepairing,
    lastRemoteSyncAt: maxOptionalNumber(current.lastRemoteSyncAt, persisted.lastRemoteSyncAt),
    operationGeneration: stateSource.operationGeneration,
    operationId: stateSource.operationId,
    pendingOperation: hasChunkDigestMismatch ? undefined : stateSource.pendingOperation,
    recoveryManifestEntries: Math.max(current.recoveryManifestEntries, persisted.recoveryManifestEntries),
    recoveryManifestTotal: Math.max(current.recoveryManifestTotal, persisted.recoveryManifestTotal),
    recoveryState: hasChunkDigestMismatch ? 'failed' : stateSource.recoveryState,
    remoteRevision: Math.max(current.remoteRevision, persisted.remoteRevision),
    status,
    submittedBytes: Math.min(totalBytes, Math.max(current.submittedBytes, persisted.submittedBytes)),
    updatedAt: Math.max(current.updatedAt, persisted.updatedAt),
    verifyingBytes: Math.max(current.verifyingBytes, persisted.verifyingBytes),
    verifyingPhase: stateSource.verifyingPhase,
    verifyingTotalBytes: Math.max(current.verifyingTotalBytes, persisted.verifyingTotalBytes)
  }
}

function mergeChunkDigestMismatches(
  current: V3OutgoingTransferTask['chunkDigestMismatches'],
  persisted: V3OutgoingTransferTask['chunkDigestMismatches']
) {
  const byKey = new Map<string, V3OutgoingTransferTask['chunkDigestMismatches'][number]>()
  for (const mismatch of persisted) byKey.set(chunkDigestMismatchKey(mismatch), mismatch)
  for (const mismatch of current) byKey.set(chunkDigestMismatchKey(mismatch), mismatch)
  return [...byKey.values()].sort((left, right) => {
    const itemOrder = left.itemId.localeCompare(right.itemId)
    return itemOrder === 0 ? left.index - right.index : itemOrder
  })
}

function chunkDigestMismatchKey(mismatch: V3OutgoingTransferTask['chunkDigestMismatches'][number]) {
  return `${mismatch.itemId}\u0000${mismatch.index}`
}

function maxOptionalNumber(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
}

function hasPendingControl(task: V3OutgoingTransferTask) {
  return task.isOptimistic && task.pendingOperation !== undefined
}

function isPendingCancellation(task: V3OutgoingTransferTask) {
  return task.status === 'cancelled'
    && task.isOptimistic
    && task.pendingOperation === 'cancel'
    && task.failureCode !== CHUNK_DIGEST_MISMATCH
}

function isRecoveryScanStart(update: V3TransferProjectionUpdate) {
  return update.status === 'recovering'
    && update.recoveryState === 'recovering'
    && update.isOptimistic === true
}

function isTerminalStatus(status: V3TransferStatus) {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function toProjectionUpdate(
  task: V3OutgoingTransferTask,
  pendingOperation: V3TransferPendingOperation | null,
  isControlSettlement = false
): V3TransferProjectionUpdate {
  return {
    confirmedBytes: task.confirmedBytes,
    confirmedRateBytesPerSecond: task.confirmedRateBytesPerSecond,
    errorCode: task.failureCode,
    isControlSettlement,
    isOptimistic: task.isOptimistic,
    isRepairing: task.isRepairing,
    lastRemoteSyncAt: task.lastRemoteSyncAt,
    operationGeneration: task.operationGeneration,
    operationId: task.operationId,
    pendingOperation,
    recoveryManifestEntries: task.recoveryManifestEntries,
    recoveryManifestTotal: task.recoveryManifestTotal,
    recoveryState: task.recoveryState,
    revision: task.remoteRevision,
    status: task.status,
    submittedBytes: task.submittedBytes,
    transferId: task.transferId,
    verifyingBytes: task.verifyingBytes,
    verifyingPhase: task.verifyingPhase,
    verifyingTotalBytes: task.verifyingTotalBytes
  }
}
