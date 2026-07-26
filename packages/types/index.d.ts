export type DeviceKind = 'desktop' | 'laptop' | 'mobile'

export type Device = {
  id: string
  ip: string
  name: string
  paired?: boolean
  type: DeviceKind
  controlPort?: number
}

export type DiscoveryAnnouncement = {
  deviceId: string
  deviceName: string
  controlPort?: number
  protocol: 'flowdrop-discovery'
  pairingAvailable?: boolean
  type: 'announce'
  version: 1
}

export type DiscoveredDevice = {
  address: string
  controlPort?: number
  deviceId: string
  deviceName: string
  lastSeenAt: number
  port: number
}

export type DiscoveryEvent =
  | {type: 'deviceFound'; device: DiscoveredDevice}
  | {type: 'deviceUpdated'; device: DiscoveredDevice}
  | {type: 'deviceLost'; device: DiscoveredDevice}
  | {type: 'error'; error: Error}

export type DiscoveryEventListener = (event: DiscoveryEvent) => void

export type DiscoveryServiceOptions = {
  announceIntervalMs?: number
  broadcastAddress?: string
  deviceTtlMs?: number
  port?: number
}

export type TrustedDevice = {
  controlPort?: number
  deviceId: string
  deviceKind: DeviceKind
  deviceName: string
  lastKnownAddress?: string
  lastSeenAt?: number
  pairedAt: number
  receiveEnabled: boolean
  updatedAt: number
}

export type TransferAdmissionRequest = {
  sourceDeviceId: string
}

export type TransferAdmissionDeniedCode = 'DEVICE_NOT_PAIRED' | 'TRANSFER_RECEIVE_DISABLED'

export type TransferAdmissionAccepted = {
  accepted: true
}

export type TransferAdmissionDenied = {
  accepted: false
  code: TransferAdmissionDeniedCode
  message: string
}

export type TransferAdmissionResponse = TransferAdmissionAccepted | TransferAdmissionDenied

export type PairingSession = {
  code: string
  createdAt: number
  expiresAt: number
  failedAttempts: number
  sessionId: string
}

export type PairingVerificationRequest = {
  code: string
  deviceId: string
  deviceKind: DeviceKind
  deviceName: string
}

export type PairingVerificationResponse = {
  trustedDevice: TrustedDevice
}

export type PairingApprovalRequest = {
  deviceId: string
  deviceKind: DeviceKind
  deviceName: string
  requestId: string
  requestedAt: number
}

export type PairingApprovalStatus = 'approved' | 'expired' | 'pending' | 'rejected'

export type PairingApprovalStatusResponse = {
  status: PairingApprovalStatus
}

export type AgentEvent = {
  eventId: string
  occurredAt: number
  payload: unknown
  type: 'device.changed' | 'pairing.requested' | 'pairing.resolved' | 'permission.changed'
}

export type PeerMessage<TPayload = unknown> = {
  id: string
  payload: TPayload
  replyTo?: string
  type: string
  v: 1
}

export type PeerHelloPayload = {
  deviceId: string
  deviceKind: DeviceKind
  deviceName: string
}

export type PeerPairingRequestPayload = {
  code: string
}

export type PeerPairingResolutionPayload = {
  requestId: string
  status: Exclude<PairingApprovalStatus, 'pending'>
}

export type PeerPairingStatusPayload = {
  requestId: string
}

export type TransferDirection = 'receive' | 'send'

export type TransmissionRecordStatus = 'interrupted' | 'success'

export type TransmissionRecordFileType = 'document' | 'image' | 'link' | 'text' | 'video'

export type TransmissionRecordFilterStatus = 'failed' | 'success'

export type TransmissionRecordFilter = {
  fileTypes: TransmissionRecordFileType[]
  statuses: TransmissionRecordFilterStatus[]
}

export type TransferRecord = {
  detail: string
  direction?: TransferDirection
  fileType?: TransmissionRecordFileType
  id: string
  name: string
  status: TransmissionRecordStatus
  time: string
}

export type TransmissionRecordDetail = Omit<TransferRecord, 'direction' | 'fileType'> & {
  dateLabel: string
  direction: TransferDirection
  fileType: TransmissionRecordFileType
}
