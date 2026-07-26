export type IPv4NetworkInterface = {
  address: string
  family: 'IPv4' | 4
  internal: boolean
  netmask: string
}

export type IPv4BroadcastTarget = {
  address: string
  broadcastAddress: string
  name: string
  netmask: string
}

export type NetworkInterfaces = Record<string, IPv4NetworkInterface[] | undefined>

/** Returns the directed broadcast address for an IPv4 address and netmask. */
export function getDirectedBroadcastAddress(address: string, netmask: string): string | null

/**
 * Returns one directed broadcast target for each non-internal IPv4 subnet reported by Node.
 * Node does not expose which interface is the active hotspot route, so callers
 * should broadcast to every returned target.
 */
export function getIPv4BroadcastTargets(networkInterfaces?: NetworkInterfaces): IPv4BroadcastTarget[]
