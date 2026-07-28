import {
  addNativeTransferChunkDigestListener,
  addNativeTransferFailureListener,
  addNativeTransferProgressListener,
  addNativeTransferStateListener,
  getNativeTransferSnapshot,
  isNativeTransferControllerAvailable,
  NativeTransferControllerError,
  reconcileNativeCancelledTransfer,
  restartNativeTransferForRecovery,
  startNativeTransfer,
  type NativeTransferChunkDigestEvent,
  type NativeTransferFailureEvent,
  type NativeTransferProgressEvent,
  type NativeTransferSnapshot,
  type NativeTransferStateEvent
} from './nativeTransferController'
import {getTransferSecret} from '@/storage/transferCredentialRepository'
import {
  CHUNK_DIGEST_MISMATCH,
  loadV3ChunkDigestManifest,
  type V3ChunkDigest,
  type V3OutgoingTransferTask,
  type V3TransferProjectionUpdate
} from '@/storage/v3TransferProjectionRepository'
import {useV3TransferProjectionStore} from '@/store/useV3TransferProjectionStore'


type NativeTransferEvent = NativeTransferFailureEvent | NativeTransferProgressEvent | NativeTransferStateEvent
type BufferedNativeEvent =
  | {event: NativeTransferStateEvent; kind: 'state'}
  | {event: NativeTransferProgressEvent; kind: 'progress'}
  | {event: NativeTransferFailureEvent; kind: 'failure'}
  | {event: NativeTransferChunkDigestEvent; kind: 'digests'}
type NativeTransferFailureObserver = (event: NativeTransferFailureEvent) => void

const MAX_BUFFERED_EVENTS_PER_TRANSFER = 4_096
const operationIds = new Map<string, string>()
const pendingEventsByTransferId = new Map<string, BufferedNativeEvent[]>()
const pendingNativeStarts = new Map<string, Promise<boolean>>()
const restartingTransferIds = new Set<string>()
const failureObservers = new Set<NativeTransferFailureObserver>()
let isStarted = false
let recoveryPromise: Promise<void> | null = null

/**
 * Owns native transfer subscriptions for the lifetime of the React runtime.
 * TransferController outlives individual screens, so page-scoped listeners
 * would otherwise drop durable ACK metadata after navigation.
 */
export function startNativeTransferProjectionRuntime(): void {
  if (isStarted || !isNativeTransferControllerAvailable()) return
  isStarted = true

  addNativeTransferStateListener((event) => handleStateEvent(event, true))
  addNativeTransferProgressListener((event) => handleProgressEvent(event, true))
  addNativeTransferFailureListener((event) => handleFailureEvent(event, true))
  addNativeTransferChunkDigestListener((event) => handleDigestEvent(event, true))
}

function beginNativeTransferRestart(transferId: string): void {
  operationIds.delete(transferId)
  restartingTransferIds.add(transferId)
}

function abortNativeTransferRestart(transferId: string): void {
  restartingTransferIds.delete(transferId)
}

export function registerNativeTransferOperation(transferId: string, operationId: string): void {
  operationIds.set(transferId, operationId)
  restartingTransferIds.delete(transferId)
}

export function projectNativeTransferSnapshot(snapshot: NativeTransferSnapshot): boolean {
  // A snapshot is observational. It must pass the same replacement fence as
  // an event; only an explicit native replacement response may register a new
  // operation id before calling this projector.
  return handleStateEvent(snapshot, true)
}

/**
 * Failure observers run only after the event passes the operation/revision
 * fence and is projected into the task store. Screens can therefore present
 * one user-visible failure without accepting stale native events.
 */
export function subscribeToNativeTransferFailures(observer: NativeTransferFailureObserver): () => void {
  failureObservers.add(observer)
  return () => failureObservers.delete(observer)
}

export function replayBufferedNativeTransferEvents(): void {
  for (const [transferId, events] of pendingEventsByTransferId) {
    pendingEventsByTransferId.delete(transferId)
    for (const entry of events) {
      switch (entry.kind) {
        case 'state':
          handleStateEvent(entry.event, false)
          break
        case 'progress':
          handleProgressEvent(entry.event, false)
          break
        case 'failure':
          handleFailureEvent(entry.event, false)
          break
        case 'digests':
          handleDigestEvent(entry.event, false)
          break
      }
    }
  }
}

/**
 * Root-level cold-start recovery. The persisted projection is first made
 * recoverable atomically, then native contacts the Agent and owns all file
 * access. A two-transfer limit avoids a restart stampeding the network.
 */
export async function recoverPersistedNativeTransfers(): Promise<void> {
  if (recoveryPromise) return recoveryPromise
  // A build without the Android controller must not mutate a resumable task
  // into a permanent failure. The UI disables V3 sends and never falls back
  // to JavaScript upload; a later compatible build can still recover it.
  if (!isNativeTransferControllerAvailable()) return

  const recovery = (async () => {
    const tasks = await useV3TransferProjectionStore.getState().prepareForNativeRecovery()
    await runWithConcurrency(tasks.map((task) => task.transferId), 2, async (transferId) => {
      try {
        await ensureNativeTransferStarted(transferId, true)
      } catch (error) {
        projectNativeTransferStartFailure(transferId, error)
        console.warn('Unable to recover V3 native transfer.', transferId, error)
      }
    })
  })()
  recoveryPromise = recovery
  try {
    await recovery
  } finally {
    if (recoveryPromise === recovery) recoveryPromise = null
  }
}

/**
 * Shared by the root recovery coordinator and the transmission screen. The
 * promise map is required because navigation can race root hydration; a second
 * native start would retire the first controller record.
 */
export async function ensureNativeTransferStarted(transferId: string, recovering: boolean): Promise<boolean> {
  const existing = pendingNativeStarts.get(transferId)
  if (existing) return existing

  const start = startNativeTransferFromProjection(transferId, recovering)
  pendingNativeStarts.set(transferId, start)
  try {
    return await start
  } finally {
    if (pendingNativeStarts.get(transferId) === start) pendingNativeStarts.delete(transferId)
  }
}

/** Lets a control command avoid targeting a record being replaced for recovery. */
export async function waitForNativeTransferStart(transferId: string): Promise<void> {
  await pendingNativeStarts.get(transferId)
}

/** Applies the same no-fallback failure policy for root and screen starts. */
export function projectNativeTransferStartFailure(transferId: string, error: unknown): void {
  const task = useV3TransferProjectionStore.getState().tasksById[transferId]
  if (!task) return
  if (isPendingCancellation(task)) return
  const errorCode = nativeTransferErrorCode(error)
  const status = isPeerUnavailableError(errorCode) ? 'waiting_for_peer' : 'failed'
  useV3TransferProjectionStore.getState().applyNativeProjection({
    confirmedBytes: task.confirmedBytes,
    confirmedRateBytesPerSecond: task.confirmedRateBytesPerSecond,
    errorCode,
    isOptimistic: false,
    isRepairing: false,
    operationGeneration: task.operationGeneration,
    operationId: task.operationId,
    pendingOperation: null,
    recoveryManifestEntries: task.recoveryManifestEntries,
    recoveryManifestTotal: task.recoveryManifestTotal,
    recoveryState: status === 'failed' ? 'failed' : task.recoveryState,
    revision: task.remoteRevision,
    status,
    submittedBytes: task.submittedBytes,
    transferId,
    verifyingBytes: task.verifyingBytes,
    verifyingPhase: task.verifyingPhase,
    verifyingTotalBytes: task.verifyingTotalBytes
  })
}

export function nativeTransferErrorCode(error: unknown): string {
  if (error instanceof NativeTransferControllerError) return error.code
  if (error instanceof Error) {
    const match = error.message.match(/[A-Z][A-Z0-9_]{2,}/)
    if (match) return match[0]
  }
  return 'TRANSFER_ENDPOINT_UNAVAILABLE'
}

async function startNativeTransferFromProjection(transferId: string, recovering: boolean): Promise<boolean> {
  if (!isNativeTransferControllerAvailable()) {
    throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  }

  const task = useV3TransferProjectionStore.getState().tasksById[transferId]
  if (!task) throw new Error('TRANSFER_NOT_FOUND')
  if (isTerminalStatus(task.status) && !(task.isOptimistic && task.pendingOperation === 'cancel')) return false
  if (isPendingCancellation(task)) {
    // The native reconciliation replaces any surviving controller record.
    // Fence its retired operation first, otherwise its final progress/state
    // event could overwrite the cancellation result with an older revision.
    beginNativeTransferRestart(transferId)
    try {
      const transferSecretHex = await getTransferSecret(task.peerDeviceId)
      if (!transferSecretHex) throw new Error('AUTHENTICATION_REQUIRED')
      const snapshot = await reconcileNativeCancelledTransfer({
        initialChunkSizeBytes: task.chunkSizeBytes,
        initialRevision: task.remoteRevision,
        items: task.items.map((item) => ({
          itemId: item.itemId,
          mimeType: item.mimeType,
          name: item.name,
          sizeBytes: item.sizeBytes,
          sourceUri: item.sourceUri
        })),
        peerAddress: task.peerAddress,
        peerControlPort: task.peerControlPort,
        sourceDeviceId: task.sourceDeviceId,
        transferId: task.transferId,
        transferSecretHex
      })
      // Successful reconciliation is an explicit replacement operation, just
      // like start/restart. It is therefore allowed to establish the next
      // event generation before its authoritative snapshot is projected.
      registerNativeTransferOperation(transferId, snapshot.operationId)
      projectNativeTransferSnapshot(snapshot)
      return true
    } catch (error) {
      // reconcileCancelledTransfer replaces a surviving Android record before
      // its first network request. Keep the replacement operation id if that
      // request fails, so a late event from the retired record cannot settle
      // this still-pending cancellation. Do not project this local snapshot:
      // only a 404 or Agent response may clear the pending cancel intent.
      const replacementSnapshot = await getNativeTransferSnapshot(transferId).catch(() => null)
      if (replacementSnapshot) {
        registerNativeTransferOperation(transferId, replacementSnapshot.operationId)
      } else {
        abortNativeTransferRestart(transferId)
      }
      throw error
    }
  }
  if (task.items.some((item) => !item.sourceUri)) throw new Error('FILE_CHANGED')

  const existingSnapshot = await getNativeTransferSnapshot(transferId)
  const restartingExistingRecord = existingSnapshot !== null && recovering
  if (existingSnapshot) {
    if (isTerminalStatus(existingSnapshot.status)) {
      projectNativeTransferSnapshot(existingSnapshot)
      return false
    }
    // A surviving Application-scoped controller can outlive React. Restart it
    // with a fresh SQLite manifest so its normal recovering path signs Agent
    // digest pages and compares them before any new chunk upload.
    if (!recovering) {
      projectNativeTransferSnapshot(existingSnapshot)
      return true
    }
  }

  if (restartingExistingRecord) beginNativeTransferRestart(transferId)
  try {
    useV3TransferProjectionStore.getState().applyNativeProjection(toStartProjection(task, recovering))
    const transferSecretHex = await getTransferSecret(task.peerDeviceId)
    if (!transferSecretHex) throw new Error('AUTHENTICATION_REQUIRED')
    const persistedChunkDigests = await loadV3ChunkDigestManifest(transferId)
    const config = {
      initialChunkSizeBytes: task.chunkSizeBytes,
      initialRevision: task.remoteRevision,
      items: task.items.map((item) => ({
        itemId: item.itemId,
        mimeType: item.mimeType,
        name: item.name,
        sizeBytes: item.sizeBytes,
        sourceUri: item.sourceUri
      })),
      peerAddress: task.peerAddress,
      peerControlPort: task.peerControlPort,
      persistedChunkDigests: persistedChunkDigests.map((digest) => ({
        confirmedRevision: digest.confirmedRevision,
        index: digest.index,
        itemId: digest.itemId,
        length: digest.length,
        sha256: digest.sha256
      })),
      recovering,
      sourceDeviceId: task.sourceDeviceId,
      transferId: task.transferId,
      transferSecretHex
    }

    if (!restartingExistingRecord) beginNativeTransferRestart(transferId)
    const operationId = existingSnapshot
      ? await restartNativeTransferForRecovery(config)
      : await startNativeTransfer(config)
    registerNativeTransferOperation(transferId, operationId)
  } catch (error) {
    abortNativeTransferRestart(transferId)
    if (restartingExistingRecord) {
      // Credential/storage setup for a replacement is a new local operation.
      // The old native record was already authorised and remains in flight, so
      // restore its authoritative snapshot instead of falsely failing it.
      const currentSnapshot = await getNativeTransferSnapshot(transferId).catch(() => existingSnapshot)
      if (currentSnapshot) {
        projectNativeTransferSnapshot(currentSnapshot)
        return !isTerminalStatus(currentSnapshot.status)
      }
      return false
    }
    throw error
  }

  const snapshot = await getNativeTransferSnapshot(transferId)
  if (snapshot) projectNativeTransferSnapshot(snapshot)
  return true
}

function toStartProjection(task: V3OutgoingTransferTask, recovering: boolean): V3TransferProjectionUpdate {
  return {
    confirmedBytes: task.confirmedBytes,
    confirmedRateBytesPerSecond: task.confirmedRateBytesPerSecond,
    isOptimistic: true,
    isRepairing: false,
    operationGeneration: task.operationGeneration,
    operationId: task.operationId,
    recoveryManifestEntries: recovering ? 0 : task.recoveryManifestEntries,
    recoveryManifestTotal: recovering ? 0 : task.recoveryManifestTotal,
    recoveryState: recovering ? 'recovering' : task.recoveryState,
    revision: task.remoteRevision,
    status: recovering ? 'recovering' : 'transferring',
    submittedBytes: task.submittedBytes,
    transferId: task.transferId,
    verifyingBytes: task.verifyingBytes,
    verifyingPhase: task.verifyingPhase,
    verifyingTotalBytes: task.verifyingTotalBytes
  }
}

function isPeerUnavailableError(code: string): boolean {
  return code === 'NETWORK_TIMEOUT' || code === 'PEER_OFFLINE' || code === 'TRANSFER_ENDPOINT_UNAVAILABLE'
}

function isTerminalStatus(status: V3OutgoingTransferTask['status']): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function isPendingCancellation(task: V3OutgoingTransferTask): boolean {
  return task.status === 'cancelled'
    && task.isOptimistic
    && task.pendingOperation === 'cancel'
    && task.failureCode !== CHUNK_DIGEST_MISMATCH
}

async function runWithConcurrency<T>(values: T[], concurrency: number, operation: (value: T) => Promise<void>): Promise<void> {
  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      await operation(values[index])
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, values.length)}, worker))
}

function handleStateEvent(event: NativeTransferStateEvent, bufferUnknown: boolean): boolean {
  if (!hasTask(event.transferId)) {
    if (bufferUnknown) bufferEvent(event.transferId, {event, kind: 'state'})
    return false
  }
  const projected = projectNativeTransferEvent(event)
  if (projected) persistChunkDigestMismatchEvidence(event)
  return projected
}

function notifyFailureObservers(event: NativeTransferFailureEvent): void {
  for (const observer of failureObservers) {
    try {
      observer(event)
    } catch (error) {
      console.warn('Unable to present a native transfer failure.', error)
    }
  }
}

function handleProgressEvent(event: NativeTransferProgressEvent, bufferUnknown: boolean): boolean {
  if (!hasTask(event.transferId)) {
    if (bufferUnknown) bufferEvent(event.transferId, {event, kind: 'progress'})
    return false
  }
  return projectNativeTransferEvent(event)
}

function handleFailureEvent(event: NativeTransferFailureEvent, bufferUnknown: boolean): boolean {
  if (!hasTask(event.transferId)) {
    if (bufferUnknown) bufferEvent(event.transferId, {event, kind: 'failure'})
    return false
  }
  const projected = projectNativeTransferEvent(event)
  if (projected) {
    persistChunkDigestMismatchEvidence(event)
    notifyFailureObservers(event)
  }
  return projected
}

function persistChunkDigestMismatchEvidence(
  event: NativeTransferFailureEvent | NativeTransferStateEvent
): void {
  if (event.errorCode !== CHUNK_DIGEST_MISMATCH || !event.chunkDigestMismatches?.length) return
  void useV3TransferProjectionStore.getState().reconcileAgentChunkDigests(
    event.transferId,
    event.chunkDigestMismatches.map((mismatch) => ({
      confirmedRevision: event.revision,
      index: mismatch.index,
      itemId: mismatch.itemId,
      length: mismatch.agentLength,
      sha256: mismatch.agentSha256
    })),
    event.revision
  ).catch((error) => {
    console.warn('Unable to persist the V3 digest mismatch evidence.', error)
  })
}

function handleDigestEvent(event: NativeTransferChunkDigestEvent, bufferUnknown: boolean): void {
  if (!hasTask(event.transferId)) {
    if (bufferUnknown) bufferEvent(event.transferId, {event, kind: 'digests'})
    return
  }
  if (!acceptNativeTransferOperation(event.transferId, event.operationId)) return
  projectNativeChunkDigests(event)
}

function projectNativeTransferEvent(event: NativeTransferEvent): boolean {
  const store = useV3TransferProjectionStore.getState()
  const task = store.tasksById[event.transferId]
  if (!task) return false
  if (!acceptNativeTransferOperation(event.transferId, event.operationId)) return false
  if ('optimistic' in event && event.optimistic && !matchesPendingNativeControl(task, event.status)) return false

  return store.applyNativeProjection(toProjectionUpdate(event, task))
}

function matchesPendingNativeControl(task: V3OutgoingTransferTask, status: NativeTransferStateEvent['status']): boolean {
  return (task.pendingOperation === 'cancel' && status === 'cancelled')
    || (task.pendingOperation === 'pause' && status === 'paused')
    || (task.pendingOperation === 'resume' && status === 'transferring')
}

function acceptNativeTransferOperation(transferId: string, operationId: string): boolean {
  // Replacement retires the old native record asynchronously. Ignore any
  // late event until the new operation id is registered and its snapshot is
  // projected as the authority.
  if (restartingTransferIds.has(transferId)) return false

  const expectedOperationId = operationIds.get(transferId)
  if (expectedOperationId && expectedOperationId !== operationId) return false
  if (!expectedOperationId) registerNativeTransferOperation(transferId, operationId)

  return true
}

function hasTask(transferId: string): boolean {
  return Boolean(useV3TransferProjectionStore.getState().tasksById[transferId])
}

function bufferEvent(transferId: string, event: BufferedNativeEvent): void {
  const events = pendingEventsByTransferId.get(transferId) ?? []
  if (events.length === MAX_BUFFERED_EVENTS_PER_TRANSFER) events.shift()
  events.push(event)
  pendingEventsByTransferId.set(transferId, events)
}

function projectNativeChunkDigests(event: NativeTransferChunkDigestEvent): void {
  if (!useV3TransferProjectionStore.getState().tasksById[event.transferId] || event.digests.length === 0) return
  const digests: V3ChunkDigest[] = event.digests.map((digest) => ({
    confirmedRevision: digest.confirmedRevision ?? event.revision,
    index: digest.index,
    itemId: digest.itemId,
    length: digest.length,
    sha256: digest.sha256
  }))
  useV3TransferProjectionStore.getState().enqueueConfirmedChunkDigests(event.transferId, digests)
}

function toProjectionUpdate(event: NativeTransferEvent, task: V3OutgoingTransferTask): V3TransferProjectionUpdate {
  const errorCode = 'errorCode' in event ? event.errorCode : undefined
  const isOptimistic = 'optimistic' in event ? event.optimistic : false
  const isRepairing = event.repairMode
  const confirmedRateBytesPerSecond = 'confirmedRateBytesPerSecond' in event
    ? event.confirmedRateBytesPerSecond
    : task.confirmedRateBytesPerSecond
  return {
    confirmedBytes: event.confirmedBytes,
    confirmedRateBytesPerSecond,
    errorCode,
    isOptimistic,
    isRepairing,
    operationGeneration: event.operationGeneration,
    operationId: event.operationId,
    pendingOperation: undefined,
    recoveryManifestEntries: event.recoveryManifestEntries,
    recoveryManifestTotal: event.recoveryManifestTotal,
    recoveryState: event.status === 'recovering' ? 'recovering' : event.status === 'failed' ? 'failed' : undefined,
    revision: event.revision,
    status: event.status,
    submittedBytes: event.submittedBytes,
    transferId: event.transferId,
    verifyingBytes: event.verifyingBytes,
    verifyingPhase: event.verifyingPhase,
    verifyingTotalBytes: event.verifyingTotalBytes
  }
}
