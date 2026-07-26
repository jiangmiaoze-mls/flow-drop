'use strict'

const os = require('node:os')

function getDirectedBroadcastAddress(address, netmask) {
  const addressOctets = parseIPv4(address)
  const netmaskOctets = parseIPv4(netmask)
  if (!addressOctets || !netmaskOctets) return null

  return addressOctets
    .map((octet, index) => (octet & netmaskOctets[index]) | (255 ^ netmaskOctets[index]))
    .join('.')
}

function getIPv4BroadcastTargets(networkInterfaces = os.networkInterfaces()) {
  const targets = []
  const seenBroadcastAddresses = new Set()

  for (const [name, addresses] of Object.entries(networkInterfaces)) {
    if (!addresses) continue

    for (const networkInterface of addresses) {
      if (
        networkInterface.internal ||
        (networkInterface.family !== 'IPv4' && networkInterface.family !== 4)
      ) {
        continue
      }

      const broadcastAddress = getDirectedBroadcastAddress(
        networkInterface.address,
        networkInterface.netmask
      )
      if (!broadcastAddress || seenBroadcastAddresses.has(broadcastAddress)) continue

      seenBroadcastAddresses.add(broadcastAddress)
      targets.push({
        address: networkInterface.address,
        broadcastAddress,
        name,
        netmask: networkInterface.netmask
      })
    }
  }

  return targets
}

function parseIPv4(value) {
  if (typeof value !== 'string') return null

  const octets = value.split('.')
  if (octets.length !== 4) return null

  const parsedOctets = octets.map((octet) => Number(octet))
  return parsedOctets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? parsedOctets
    : null
}

module.exports = {
  getDirectedBroadcastAddress,
  getIPv4BroadcastTargets
}
