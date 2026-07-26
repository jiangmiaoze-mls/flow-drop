export type DeviceKind = 'desktop' | 'laptop'

export type Device = {
  authorized?: boolean
  id: string
  ip: string
  name: string
  type: DeviceKind
}

export type DiscoveryAnnouncement = {
  deviceId: string
  deviceName: string
  protocol: 'flowdrop-discovery'
  type: 'announce'
  version: 1
}

export type DiscoveredDevice = {
  address: string
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
