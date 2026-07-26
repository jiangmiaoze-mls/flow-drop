import * as Crypto from 'expo-crypto'

import type {
  Device,
  PairingVerificationRequest,
  PeerHelloPayload,
  PeerMessage,
  PeerPairingResolutionPayload
} from '@flowdrop/types'


const PAIRING_WAIT_TIMEOUT_MS = 65_000

export type PairingErrorCode =
  | 'INVALID_PAIRING_CODE'
  | 'PAIRING_APPROVAL_EXPIRED'
  | 'PAIRING_REJECTED'

export class PairingError extends Error {
  constructor(public readonly code: PairingErrorCode) {
    super(code)
    this.name = 'PairingError'
  }
}

export async function verifyPairingCode(
  peer: Device,
  request: PairingVerificationRequest
): Promise<void> {
  if (!peer.controlPort) {
    throw new Error('The selected device does not expose a pairing endpoint.')
  }

  const requestId = Crypto.randomUUID()
  const hello: PeerHelloPayload = {
    deviceId: request.deviceId,
    deviceKind: request.deviceKind,
    deviceName: request.deviceName
  }
  const endpoint = `ws://${peer.ip}:${peer.controlPort}/v1/peer`

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let hasSubmittedRequest = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let socket: WebSocket | null = null
    let reconnectScheduled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new PairingError('PAIRING_APPROVAL_EXPIRED')), PAIRING_WAIT_TIMEOUT_MS)

    const scheduleReconnect = () => {
      if (settled || reconnectScheduled) return
      reconnectScheduled = true
      reconnectTimer = setTimeout(() => {
        reconnectScheduled = false
        connect()
      }, 1_000)
    }

    const connect = () => {
      if (settled) return
      const nextSocket = new WebSocket(endpoint)
      socket = nextSocket
      nextSocket.onopen = () => {
        if (socket !== nextSocket) return
        sendMessage(nextSocket, {
          id: Crypto.randomUUID(),
          payload: hello,
          type: 'peer.hello',
          v: 1
        })
        if (hasSubmittedRequest) {
          sendMessage(nextSocket, {
            id: Crypto.randomUUID(),
            payload: {requestId},
            type: 'pairing.status',
            v: 1
          })
          return
        }

        sendMessage(nextSocket, {
          id: requestId,
          payload: {code: request.code},
          type: 'pairing.request',
          v: 1
        })
        hasSubmittedRequest = true
      }
      nextSocket.onerror = () => {
        if (socket !== nextSocket) return
        nextSocket.close()
        scheduleReconnect()
      }
      nextSocket.onclose = () => {
        if (socket === nextSocket) scheduleReconnect()
      }
      nextSocket.onmessage = (event) => {
        const message = parseMessage(event.data)
        if (!message) return

        if (message.type === 'peer.error') {
          const code = (message.payload as {code?: unknown}).code
          if (code === 'INVALID_PAIRING_CODE') finish(new PairingError('INVALID_PAIRING_CODE'))
          if (code === 'PAIRING_REQUEST_NOT_FOUND') finish(new PairingError('PAIRING_APPROVAL_EXPIRED'))
          return
        }
        if (message.type !== 'pairing.resolved') return

        const payload = message.payload as Partial<PeerPairingResolutionPayload>
        if (payload.requestId !== requestId) return
        if (payload.status === 'approved') {
          finish()
        } else if (payload.status === 'rejected') {
          finish(new PairingError('PAIRING_REJECTED'))
        } else {
          finish(new PairingError('PAIRING_APPROVAL_EXPIRED'))
        }
      }
    }

    connect()
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

function sendMessage(socket: WebSocket, message: PeerMessage) {
  socket.send(JSON.stringify(message))
}
