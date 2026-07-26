export type WifiIPv4BroadcastTarget = {
  address: string
  broadcastAddress: string
  netmask: string
}

export function getWifiIPv4BroadcastTargetAsync(): Promise<WifiIPv4BroadcastTarget | null>
