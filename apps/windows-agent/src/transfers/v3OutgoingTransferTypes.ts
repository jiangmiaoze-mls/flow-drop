export type V3OutgoingTransferStatus = 'cancelled' | 'completed' | 'failed' | 'paused' | 'preparing' | 'transferring' | 'waiting_for_peer'

export type V3OutgoingTransferItem = {
  contentRoot: string
  itemId: string
  mimeType: string
  name: string
  sizeBytes: number
}

export type V3OutgoingTransferOffer = {
  chunkSizeBytes: number
  items: V3OutgoingTransferItem[]
  revision: number
  transferId: string
}

export type V3OutgoingTransferStatusResponse = V3OutgoingTransferOffer & {
  acknowledgedRanges: Record<string, Array<[start: number, end: number]>>
  status: V3OutgoingTransferStatus
}

export type V3OutgoingTransferChunk = {
  data: Buffer
  end: number
  sha256: string
  start: number
  total: number
}

export type V3OutgoingTransferSourceItem = {
  itemId: string
  mimeType: string
  name: string
  sourcePath: string
}

export type V3OutgoingTransferCreation = {
  chunkSizeBytes?: number
  items: V3OutgoingTransferSourceItem[]
  recipientDeviceId: string
  transferId?: string
}
