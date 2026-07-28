// Expo re-exports this exact Expo Modules Core helper. Importing through the
// app's direct Expo dependency keeps TypeScript resolution valid under pnpm.
import {requireOptionalNativeModule} from 'expo'


export type NativeTransferStatus =
  | 'negotiating'
  | 'queued'
  | 'waiting_for_peer'
  | 'preparing'
  | 'recovering'
  | 'transferring'
  | 'paused'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type NativeTransferItemConfig = {
  itemId: string
  mimeType: string
  name: string
  sizeBytes: number
  sourceUri: string
}

export type NativePersistedChunkDigest = {
  confirmedRevision?: number
  index: number
  itemId: string
  length: number
  sha256: string
}

export type NativeChunkDigestMismatch = {
  agentLength: number
  agentSha256: string
  index: number
  itemId: string
  localLength: number
  localSha256: string
}

/**
 * This crosses the Expo bridge as metadata only. File contents stay in the
 * Android controller and are never read by JavaScript.
 */
export type NativeTransferStartConfig = {
  initialChunkSizeBytes?: number
  initialRevision?: number
  items: NativeTransferItemConfig[]
  peerAddress: string
  peerControlPort: number
  persistedChunkDigests?: NativePersistedChunkDigest[]
  recovering?: boolean
  sourceDeviceId: string
  transferId: string
  transferSecretHex: string
}

export type NativeIncomingTransferItem = {
  contentRoot: string
  itemId: string
  mimeType: string
  name: string
  sizeBytes: number
}

/** Metadata-only Agent-to-Android offer. Native code owns all downloaded bytes. */
export type NativeIncomingTransferStartConfig = {
  chunkSizeBytes: number
  items: NativeIncomingTransferItem[]
  peerAddress: string
  peerControlPort: number
  recipientDeviceId: string
  revision: number
  transferId: string
  transferSecretHex: string
}

export type NativeTransferSnapshot = {
  chunkDigestMismatches?: NativeChunkDigestMismatch[]
  confirmedBytes: number
  confirmedRateBytesPerSecond: number
  errorCode?: string
  operationGeneration: number
  operationId: string
  optimistic: boolean
  repairMode: boolean
  recoveryManifestEntries: number
  recoveryManifestTotal: number
  revision: number
  status: NativeTransferStatus
  submittedBytes: number
  transferId: string
  verifyingBytes: number
  verifyingPhase: 'idle' | 'reading' | 'hashing' | 'done'
  verifyingTotalBytes: number
}

export type NativeTransferStateEvent = NativeTransferSnapshot

export type NativeTransferProgressEvent = {
  confirmedBytes: number
  confirmedRateBytesPerSecond: number
  operationGeneration: number
  operationId: string
  repairMode: boolean
  recoveryManifestEntries: number
  recoveryManifestTotal: number
  revision: number
  status: NativeTransferStatus
  submittedBytes: number
  transferId: string
  verifyingBytes: number
  verifyingPhase: 'idle' | 'reading' | 'hashing' | 'done'
  verifyingTotalBytes: number
}

export type NativeTransferFailureEvent = {
  chunkDigestMismatches?: NativeChunkDigestMismatch[]
  confirmedBytes: number
  errorCode: string
  operationGeneration: number
  operationId: string
  repairMode: boolean
  recoveryManifestEntries: number
  recoveryManifestTotal: number
  revision: number
  status: NativeTransferStatus
  submittedBytes: number
  transferId: string
  verifyingBytes: number
  verifyingPhase: 'idle' | 'reading' | 'hashing' | 'done'
  verifyingTotalBytes: number
}

export type NativeTransferChunkDigestEvent = {
  digests: NativePersistedChunkDigest[]
  operationGeneration: number
  operationId: string
  revision: number
  transferId: string
}

export type NativeTransferControlResponse = {
  revision: number
  status: 'paused' | 'transferring' | 'cancelled'
}

export type NativeIncomingTransferEvent = {
  confirmedBytes: number
  errorCode?: string
  localUris?: Record<string, string>
  revision: number
  status: 'cancelled' | 'completed' | 'failed' | 'paused' | 'transferring'
  transferId: string
}

export type NativeTransferSourceStageConfig = {
  items: Array<Pick<NativeTransferItemConfig, 'itemId' | 'name' | 'sizeBytes' | 'sourceUri'>>
  transferId: string
}

export type NativeTransferEventSubscription = {
  remove(): void
}

type NativeTransferEventName = 'incomingTransferFailure' | 'incomingTransferState' | 'transferChunkDigests' | 'transferFailure' | 'transferProgress' | 'transferState'

type FlowDropNetworkTransferModule = {
  addListener?: (eventName: NativeTransferEventName, listener: (event: unknown) => void) => NativeTransferEventSubscription
  cancelTransfer?: (transferId: string) => Promise<NativeTransferControlResponse>
  cancelIncomingTransfer?: (transferId: string) => Promise<void>
  getTransferSnapshot?: (transferId: string) => Promise<NativeTransferSnapshot | null>
  getIncomingTransferSnapshots?: () => Promise<NativeIncomingTransferEvent[]>
  pauseTransfer?: (transferId: string) => Promise<NativeTransferControlResponse>
  pauseIncomingTransfer?: (transferId: string) => Promise<void>
  reconcileCancelledTransfer?: (config: NativeTransferStartConfig) => Promise<NativeTransferSnapshot>
  stageTransferSources?: (config: NativeTransferSourceStageConfig) => Promise<Record<string, string>>
  deleteIncomingTransferFiles?: (transferId: string) => Promise<void>
  deleteOutgoingTransferFiles?: (transferId: string) => Promise<void>
  cleanupLegacyTransferFiles?: () => Promise<void>
  openManagedFile?: (fileUri: string) => Promise<void>
  restartTransferForRecovery?: (config: NativeTransferStartConfig) => Promise<string>
  resumeTransfer?: (transferId: string) => Promise<NativeTransferControlResponse>
  resumeIncomingTransfer?: (transferId: string) => Promise<void>
  startTransfer?: (config: NativeTransferStartConfig) => Promise<string>
  startIncomingTransfer?: (config: NativeIncomingTransferStartConfig) => Promise<string>
}

const flowDropNetwork = requireOptionalNativeModule<FlowDropNetworkTransferModule>('FlowDropNetwork')

export type NativeTransferControllerErrorCode = 'NATIVE_TRANSFER_UNAVAILABLE'

export class NativeTransferControllerError extends Error {
  constructor(public readonly code: NativeTransferControllerErrorCode) {
    super(code)
    this.name = 'NativeTransferControllerError'
  }
}

export function isNativeTransferControllerAvailable(): boolean {
  return Boolean(
    flowDropNetwork
      && typeof flowDropNetwork.startTransfer === 'function'
      && typeof flowDropNetwork.pauseTransfer === 'function'
      && typeof flowDropNetwork.resumeTransfer === 'function'
      && typeof flowDropNetwork.cancelTransfer === 'function'
      && typeof flowDropNetwork.getTransferSnapshot === 'function'
      && typeof flowDropNetwork.reconcileCancelledTransfer === 'function'
      && typeof flowDropNetwork.stageTransferSources === 'function'
      && typeof flowDropNetwork.restartTransferForRecovery === 'function'
      && typeof flowDropNetwork.addListener === 'function'
  )
}

export async function startNativeTransfer(config: NativeTransferStartConfig): Promise<string> {
  return requireNativeTransferController().startTransfer(config)
}

export async function startNativeIncomingTransfer(config: NativeIncomingTransferStartConfig): Promise<string> {
  const module = requireNativeTransferController()
  if (typeof module.startIncomingTransfer !== 'function') {
    throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  }
  return module.startIncomingTransfer(config)
}

export async function pauseNativeIncomingTransfer(transferId: string): Promise<void> {
  const module = requireNativeTransferController()
  if (typeof module.pauseIncomingTransfer !== 'function') throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  await module.pauseIncomingTransfer(transferId)
}

export async function resumeNativeIncomingTransfer(transferId: string): Promise<void> {
  const module = requireNativeTransferController()
  if (typeof module.resumeIncomingTransfer !== 'function') throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  await module.resumeIncomingTransfer(transferId)
}

export async function cancelNativeIncomingTransfer(transferId: string): Promise<void> {
  const module = requireNativeTransferController()
  if (typeof module.cancelIncomingTransfer !== 'function') throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  await module.cancelIncomingTransfer(transferId)
}

export async function restartNativeTransferForRecovery(config: NativeTransferStartConfig): Promise<string> {
  return requireNativeTransferController().restartTransferForRecovery(config)
}

export async function reconcileNativeCancelledTransfer(config: NativeTransferStartConfig): Promise<NativeTransferSnapshot> {
  return requireNativeTransferController().reconcileCancelledTransfer(config)
}

export async function stageNativeTransferSources(config: NativeTransferSourceStageConfig): Promise<Record<string, string>> {
  const module = requireNativeTransferController()
  if (typeof module.stageTransferSources !== 'function') throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  return module.stageTransferSources(config)
}

export async function deleteNativeIncomingTransferFiles(transferId: string): Promise<void> {
  const module = requireNativeTransferController()
  if (typeof module.deleteIncomingTransferFiles !== 'function') throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  await module.deleteIncomingTransferFiles(transferId)
}

export async function deleteNativeOutgoingTransferFiles(transferId: string): Promise<void> {
  const module = requireNativeTransferController()
  if (typeof module.deleteOutgoingTransferFiles !== 'function') throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  await module.deleteOutgoingTransferFiles(transferId)
}

export async function cleanupLegacyNativeTransferFiles(): Promise<void> {
  if (!flowDropNetwork || typeof flowDropNetwork.cleanupLegacyTransferFiles !== 'function') return
  await flowDropNetwork.cleanupLegacyTransferFiles()
}

export async function openNativeManagedFile(fileUri: string): Promise<void> {
  const module = requireNativeTransferController()
  if (typeof module.openManagedFile !== 'function') throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  await module.openManagedFile(fileUri)
}

export async function pauseNativeTransfer(transferId: string): Promise<NativeTransferControlResponse> {
  return requireNativeTransferController().pauseTransfer(transferId)
}

export async function resumeNativeTransfer(transferId: string): Promise<NativeTransferControlResponse> {
  return requireNativeTransferController().resumeTransfer(transferId)
}

export async function cancelNativeTransfer(transferId: string): Promise<NativeTransferControlResponse> {
  return requireNativeTransferController().cancelTransfer(transferId)
}

export async function getNativeTransferSnapshot(transferId: string): Promise<NativeTransferSnapshot | null> {
  return requireNativeTransferController().getTransferSnapshot(transferId)
}

export async function getNativeIncomingTransferSnapshots(): Promise<NativeIncomingTransferEvent[]> {
  const module = requireNativeTransferController()
  if (typeof module.getIncomingTransferSnapshots !== 'function') return []
  return module.getIncomingTransferSnapshots()
}

export function addNativeTransferStateListener(
  listener: (event: NativeTransferStateEvent) => void
): NativeTransferEventSubscription {
  return addNativeTransferListener('transferState', listener)
}

export function addNativeTransferProgressListener(
  listener: (event: NativeTransferProgressEvent) => void
): NativeTransferEventSubscription {
  return addNativeTransferListener('transferProgress', listener)
}

export function addNativeTransferFailureListener(
  listener: (event: NativeTransferFailureEvent) => void
): NativeTransferEventSubscription {
  return addNativeTransferListener('transferFailure', listener)
}

export function addNativeTransferChunkDigestListener(
  listener: (event: NativeTransferChunkDigestEvent) => void
): NativeTransferEventSubscription {
  return addNativeTransferListener('transferChunkDigests', listener)
}

export function addNativeIncomingTransferStateListener(
  listener: (event: NativeIncomingTransferEvent) => void
): NativeTransferEventSubscription {
  return addNativeTransferListener('incomingTransferState', listener)
}

export function addNativeIncomingTransferFailureListener(
  listener: (event: NativeIncomingTransferEvent) => void
): NativeTransferEventSubscription {
  return addNativeTransferListener('incomingTransferFailure', listener)
}

function addNativeTransferListener<TEvent>(
  eventName: NativeTransferEventName,
  listener: (event: TEvent) => void
): NativeTransferEventSubscription {
  return requireNativeTransferController().addListener(eventName, (event) => listener(event as TEvent))
}

function requireNativeTransferController(): Required<FlowDropNetworkTransferModule> {
  if (!isNativeTransferControllerAvailable()) {
    throw new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE')
  }
  return flowDropNetwork as Required<FlowDropNetworkTransferModule>
}
