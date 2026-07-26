export type WifiIPv4BroadcastTarget = {
  address: string
  broadcastAddress: string
  netmask: string
}

export type NativeFileHash = {
  sha256: string
  sizeBytes: number
}

export type NativeFileHashProgress = {
  operationId: string
  processedBytes: number
  totalBytes: number
}

export type NativeEventSubscription = {
  remove(): void
}

export function getWifiIPv4BroadcastTargetAsync(): Promise<WifiIPv4BroadcastTarget | null>
export function sha256FileAsync(uri: string, operationId: string): Promise<NativeFileHash | null>
export function addSha256ProgressListener(listener: (event: NativeFileHashProgress) => void): NativeEventSubscription
