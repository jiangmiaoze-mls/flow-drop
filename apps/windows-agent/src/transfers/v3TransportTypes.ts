export const V3_PROTOCOL = 3 as const
export const V3_DEFAULT_CHUNK_BYTES = 1024 * 1024
export const V3_MIN_CHUNK_BYTES = 1024 * 1024
export const V3_MAX_CHUNK_BYTES = 4 * 1024 * 1024
export const V3_MAX_IN_FLIGHT_CHUNKS = 2
export const V3_MAX_CREATE_BODY_BYTES = 64 * 1024
export const V3_MAX_ITEMS_PER_TRANSFER = 32

export type V3TransferStatus =
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

export type V3TransferControlStatus = 'paused' | 'transferring' | 'cancelled'

export type V3TransferControlResponse = {
  revision: number
  status: V3TransferControlStatus
}

export type V3VerificationPhase = 'idle' | 'reading' | 'hashing' | 'done'

export type V3TransferItem = {
  itemId: string
  mimeType: string
  name: string
  sizeBytes: number
}

export type V3CreateTransferRequest = {
  chunkSizeBytes: number
  items: V3TransferItem[]
  protocol: typeof V3_PROTOCOL
  sourceDeviceId: string
  transferId: string
}

export type V3ItemProgress = {
  itemId: string
  receivedBytes: number
  receivedRanges: Array<[start: number, end: number]>
}

export type V3CreateTransferResponse = {
  chunkSizeBytes: number
  items: V3ItemProgress[]
  protocol: typeof V3_PROTOCOL
  revision: number
  status: V3TransferStatus
  transferId: string
  transferReceivedBytes: number
}

export type V3ChunkAck = {
  chunkIndex: number
  itemId: string
  receivedBytes: number
  revision: number
  transferReceivedBytes: number
}

export type V3CompletionFile = {
  contentRoot: string
  itemId: string
}

export type V3TransferStatusSnapshot = {
  errorCode?: string
  items: Array<{
    itemId: string
    receivedRanges: Array<[start: number, end: number]>
  }>
  revision: number
  status: V3TransferStatus
  transferReceivedBytes: number
  verifyingBytes: number
  verifyingPhase: V3VerificationPhase
  verifyingTotalBytes: number
}

export type V3ChunkDigestPage = {
  digests: Array<{
    index: number
    length: number
    sha256: string
  }>
  total: number
}

export type V3TransportCapabilities = {
  maxChunkBytes: number
  maxInFlightChunks: number
  protocols: [typeof V3_PROTOCOL]
}

export type V3AdminTransferSnapshot = {
  chunkSizeBytes: number
  createdAt: number
  direction: 'receive'
  errorCode?: string
  items: Array<{
    itemId: string
    mimeType: string
    name: string
    receivedBytes: number
    sizeBytes: number
  }>
  peerDeviceId: string
  revision: number
  status: V3TransferStatus
  totalBytes: number
  transferId: string
  transferredBytes: number
  updatedAt: number
  verifyingBytes: number
  verifyingPhase: V3VerificationPhase
  verifyingTotalBytes: number
}
