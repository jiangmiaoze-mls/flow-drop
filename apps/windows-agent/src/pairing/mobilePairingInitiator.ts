import {randomUUID} from 'node:crypto'
import os from 'node:os'

import {PAIRING_CONTROL_PORT} from '@flowdrop/config'
import type {DiscoveredDevice, PeerMessage, PeerPairingResolutionPayload, TrustedDevice} from '@flowdrop/types'

import type {TrustedDeviceStore} from '../storage/trustedDeviceStore'


const PAIRING_WAIT_TIMEOUT_MS = 65_000

export async function initiateMobilePairing(
  device: DiscoveredDevice,
  code: string,
  agentDeviceId: string,
  trustedDeviceStore: TrustedDeviceStore
): Promise<TrustedDevice> {
  if (!/^\d{6}$/.test(code)) throw new Error('A six-digit pairing code is required.')
  const controlPort = device.controlPort ?? PAIRING_CONTROL_PORT
  const endpoint = `ws://${device.address}:${controlPort}/v1/peer`
  const requestId = randomUUID()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(endpoint)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.close()
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error('Pairing approval timed out.')), PAIRING_WAIT_TIMEOUT_MS)

    socket.addEventListener('open', () => {
      send(socket, {
        id: randomUUID(),
        payload: {deviceId: agentDeviceId, deviceKind: 'desktop', deviceName: os.hostname()},
        type: 'peer.hello',
        v: 1
      })
      send(socket, {id: requestId, payload: {code}, type: 'pairing.request', v: 1})
    })
    socket.addEventListener('error', () => finish(new Error('Unable to connect to the mobile pairing endpoint.')))
    socket.addEventListener('message', (event) => {
      const message = parseMessage(event.data)
      if (!message) return
      if (message.type === 'peer.error') {
        const errorCode = (message.payload as {code?: unknown}).code
        finish(new Error(typeof errorCode === 'string' ? errorCode : 'Pairing was rejected by the mobile endpoint.'))
        return
      }
      if (message.type !== 'pairing.resolved') return
      const payload = message.payload as Partial<PeerPairingResolutionPayload>
      if (payload.requestId !== requestId) return
      finish(payload.status === 'approved' ? undefined : new Error(`Pairing ${payload.status ?? 'failed'}.`))
    })
  })

  const now = Date.now()
  const existing = trustedDeviceStore.get(device.deviceId)
  return trustedDeviceStore.upsert({
    controlPort,
    deviceId: device.deviceId,
    deviceKind: 'mobile',
    deviceName: device.deviceName,
    lastKnownAddress: device.address,
    lastSeenAt: now,
    pairedAt: existing?.pairedAt ?? now,
    receiveEnabled: existing?.receiveEnabled ?? true,
    updatedAt: now
  })
}

function parseMessage(value: unknown): PeerMessage | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    const message = parsed as Record<string, unknown>
    return message.v === 1 && typeof message.id === 'string' && typeof message.type === 'string'
      ? parsed as PeerMessage
      : null
  } catch {
    return null
  }
}

function send(socket: WebSocket, message: PeerMessage) {
  socket.send(JSON.stringify(message))
}
