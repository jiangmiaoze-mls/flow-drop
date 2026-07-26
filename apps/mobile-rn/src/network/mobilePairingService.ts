import * as Crypto from 'expo-crypto'
import TcpSocket from 'react-native-tcp-socket'
import type Server from 'react-native-tcp-socket/lib/types/Server'
import type Socket from 'react-native-tcp-socket/lib/types/Socket'

import {PAIRING_CONTROL_PORT} from '@flowdrop/config'
import {getDeviceId} from '@/network/discoveryService'
import type {
  DeviceKind,
  PairingApprovalStatus,
  PairingSession,
  PeerHelloPayload,
  PeerMessage,
  PeerPairingResolutionPayload
} from '@flowdrop/types'


const MAX_MESSAGE_BYTES = 4_096
const PAIRING_SESSION_TTL_MS = 2 * 60 * 1_000
const PAIRING_REQUEST_TTL_MS = 60_000
const WEBSOCKET_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export type MobilePairingRequest = {
  address: string
  deviceId: string
  deviceKind: DeviceKind
  deviceName: string
  requestId: string
  requestedAt: number
}

type PendingPairingRequest = MobilePairingRequest & {connection: MobilePeerConnection}

type MobilePeerConnection = {
  device?: PeerHelloPayload
  id: string
  remoteAddress: string
  receive: (data: string) => void
  send: (type: string, payload: unknown, replyTo?: string) => void
}

/**
 * Provides the mobile endpoint for Agent-initiated pairing while the app is in
 * the foreground. The code is an expiring session secret, not a device ID.
 */
export class MobilePairingService {
  private readonly connections = new Map<string, MobilePeerConnection>()
  private readonly listeners = new Set<(request: MobilePairingRequest) => void>()
  private readonly pendingRequests = new Map<string, PendingPairingRequest>()
  private readonly sessions = new Map<string, PairingSession>()
  private deviceId: string | null = null
  private server: Server | null = null
  private startPromise: Promise<void> | null = null

  get activeSession(): PairingSession | null {
    this.removeExpiredRecords()
    return [...this.sessions.values()].sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  }

  async start(): Promise<void> {
    if (this.server?.listening) return
    if (this.startPromise) return this.startPromise

    const startWork = (async () => {
      this.deviceId = await getDeviceId()
      await new Promise<void>((resolve, reject) => {
        const server = TcpSocket.createServer((socket) => this.registerConnection(socket))
        const onError = (error: Error) => {
          server.removeListener('listening', onListening)
          if (this.server === server) this.server = null
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          this.server = server
          resolve()
        }

        server.once('error', onError)
        server.once('listening', onListening)
        try {
          server.listen({host: '0.0.0.0', port: PAIRING_CONTROL_PORT, reuseAddress: true})
        } catch (error) {
          onError(toError(error))
        }
      })
      await this.createSession()
    })()

    const startPromise = startWork.finally(() => {
      if (this.startPromise === startPromise) this.startPromise = null
    })
    this.startPromise = startPromise
    return startPromise
  }

  stop() {
    for (const connection of this.connections.values()) connection.receive('')
    this.connections.clear()
    this.pendingRequests.clear()
    this.sessions.clear()
    this.server?.close()
    this.server = null
  }

  async createSession(): Promise<PairingSession> {
    this.removeExpiredRecords()
    const session: PairingSession = {
      code: await createPairingCode(),
      createdAt: Date.now(),
      expiresAt: Date.now() + PAIRING_SESSION_TTL_MS,
      failedAttempts: 0,
      sessionId: Crypto.randomUUID()
    }
    this.sessions.clear()
    this.sessions.set(session.sessionId, session)
    return session
  }

  getPendingRequests(): MobilePairingRequest[] {
    this.removeExpiredRecords()
    return [...this.pendingRequests.values()]
      .map(({connection: _connection, ...request}) => request)
      .sort((left, right) => left.requestedAt - right.requestedAt)
  }

  subscribe(listener: (request: MobilePairingRequest) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  resolvePairingRequest(requestId: string, status: Exclude<PairingApprovalStatus, 'pending'>): MobilePairingRequest | null {
    this.removeExpiredRecords()
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null

    this.pendingRequests.delete(requestId)
    pending.connection.send('pairing.resolved', {
      requestId,
      status
    } satisfies PeerPairingResolutionPayload)
    return toMobilePairingRequest(pending)
  }

  private registerConnection(socket: Socket) {
    const connection = createMobilePeerConnection(socket, (message, peer) => this.handleMessage(peer, message))
    this.connections.set(connection.id, connection)
  }

  private handleMessage(connection: MobilePeerConnection, message: PeerMessage) {
    if (message.type === 'peer.hello') {
      if (!isPeerHelloPayload(message.payload)) {
        connection.send('peer.error', {code: 'INVALID_HELLO'}, message.id)
        return
      }
      connection.device = message.payload
      connection.send('peer.ready', {connectionId: connection.id}, message.id)
      return
    }

    if (!connection.device) {
      connection.send('peer.error', {code: 'HELLO_REQUIRED'}, message.id)
      return
    }

    if (message.type === 'pairing.request') {
      const code = (message.payload as {code?: unknown})?.code
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        connection.send('peer.error', {code: 'INVALID_PAIRING_REQUEST'}, message.id)
        return
      }
      this.requestApproval(connection, message.id, code)
      return
    }

    if (message.type === 'pairing.status') {
      const requestId = (message.payload as {requestId?: unknown})?.requestId
      const pending = typeof requestId === 'string' ? this.pendingRequests.get(requestId) : undefined
      if (!pending) {
        connection.send('peer.error', {code: 'PAIRING_REQUEST_NOT_FOUND'}, message.id)
      } else {
        connection.send('pairing.pending', {requestId}, message.id)
      }
      return
    }

    connection.send('peer.error', {code: 'UNSUPPORTED_MESSAGE'}, message.id)
  }

  private requestApproval(connection: MobilePeerConnection, requestId: string, code: string) {
    this.removeExpiredRecords()
    const session = [...this.sessions.values()].find((candidate) => candidate.code === code)
    if (!session) {
      connection.send('peer.error', {code: 'INVALID_PAIRING_CODE'}, requestId)
      return
    }
    this.sessions.delete(session.sessionId)

    const device = connection.device
    if (!device) return
    const request: PendingPairingRequest = {
      address: connection.remoteAddress,
      connection,
      deviceId: device.deviceId,
      deviceKind: device.deviceKind,
      deviceName: device.deviceName,
      requestId,
      requestedAt: Date.now()
    }
    this.pendingRequests.set(requestId, request)
    connection.send('pairing.pending', {requestId}, requestId)
    for (const listener of this.listeners) listener(toMobilePairingRequest(request))
  }

  private removeExpiredRecords() {
    const now = Date.now()
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId)
    }
    for (const [requestId, request] of this.pendingRequests) {
      if (request.requestedAt + PAIRING_REQUEST_TTL_MS > now) continue
      this.pendingRequests.delete(requestId)
      request.connection.send('pairing.resolved', {
        requestId,
        status: 'expired'
      } satisfies PeerPairingResolutionPayload)
    }
  }
}

export const mobilePairingService = new MobilePairingService()

function createMobilePeerConnection(
  socket: Socket,
  onMessage: (message: PeerMessage, connection: MobilePeerConnection) => void
): MobilePeerConnection {
  const id = Crypto.randomUUID()
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0) as Uint8Array<ArrayBufferLike>
  let handshakeComplete = false
  let handshakeInProgress = false
  const connection: MobilePeerConnection = {
    id,
    remoteAddress: socket.remoteAddress ?? '',
    receive: (data) => {
      buffer = appendBytes(buffer, latin1ToBytes(data))
      if (!handshakeComplete) {
        if (!handshakeInProgress) void completeHandshake()
        return
      }
      readFrames()
    },
    send: (type, payload, replyTo) => {
      const message: PeerMessage = {id: Crypto.randomUUID(), payload, replyTo, type, v: 1}
      const payloadBytes = new TextEncoder().encode(JSON.stringify(message))
      if (payloadBytes.length > MAX_MESSAGE_BYTES) return
      socket.write(createServerFrame(payloadBytes))
    }
  }

  socket.setEncoding('binary')
  socket.on('data', (data: string | Uint8Array) => connection.receive(typeof data === 'string' ? data : data.toString()))
  socket.on('error', () => socket.destroy())
  socket.on('close', () => undefined)

  const completeHandshake = async () => {
    const headerEnd = indexOfHeaderEnd(buffer)
    if (headerEnd < 0) return
    handshakeInProgress = true
    const request = asciiFromBytes(buffer.slice(0, headerEnd))
    buffer = buffer.slice(headerEnd + 4)
    const webSocketKey = parseWebSocketKey(request)
    if (!webSocketKey) {
      socket.destroy()
      return
    }

    try {
      const accept = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA1,
        `${webSocketKey}${WEBSOCKET_ACCEPT_GUID}`,
        {encoding: Crypto.CryptoEncoding.BASE64}
      )
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      handshakeComplete = true
      handshakeInProgress = false
      readFrames()
    } catch {
      socket.destroy()
    }
  }

  const readFrames = () => {
    while (buffer.length >= 2) {
      const first = buffer[0]
      const second = buffer[1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let payloadLength = second & 0x7f
      let offset = 2
      if (payloadLength === 126) {
        if (buffer.length < 4) return
        payloadLength = buffer[2] * 256 + buffer[3]
        offset = 4
      }
      if (!masked || payloadLength > MAX_MESSAGE_BYTES || buffer.length < offset + 4 + payloadLength) {
        if (!masked || payloadLength > MAX_MESSAGE_BYTES) socket.destroy()
        return
      }
      const mask = buffer.slice(offset, offset + 4)
      offset += 4
      const payload = buffer.slice(offset, offset + payloadLength)
      buffer = buffer.slice(offset + payloadLength)
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]

      if (opcode === 0x8) {
        socket.end()
        return
      }
      if (opcode === 0x9) {
        socket.write(createServerFrame(payload, 0xA))
        continue
      }
      if (opcode !== 0x1) continue
      const message = parsePeerMessage(new TextDecoder().decode(payload))
      if (message) onMessage(message, connection)
    }
  }

  // socket.remoteAddress is populated asynchronously by some Android builds.
  setTimeout(() => {
    connection.remoteAddress = socket.remoteAddress ?? connection.remoteAddress
  }, 0)
  return connection
}

function parseWebSocketKey(request: string): string | null {
  const lines = request.split('\r\n')
  if (!/^GET \/v1\/peer HTTP\/1\.1$/.test(lines[0] ?? '')) return null
  const headers = new Map(lines.slice(1).map((line) => {
    const separator = line.indexOf(':')
    return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()]
  }))
  return headers.get('upgrade')?.toLowerCase() === 'websocket' && headers.get('sec-websocket-version') === '13'
    ? headers.get('sec-websocket-key') ?? null
    : null
}

function parsePeerMessage(value: string): PeerMessage | null {
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

function isPeerHelloPayload(value: unknown): value is PeerHelloPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.deviceId === 'string' && payload.deviceId.length > 0 && payload.deviceId.length <= 128 &&
    typeof payload.deviceName === 'string' && payload.deviceName.trim().length > 0 && payload.deviceName.length <= 128 &&
    (payload.deviceKind === 'desktop' || payload.deviceKind === 'laptop' || payload.deviceKind === 'mobile')
  )
}

async function createPairingCode(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(4)
  const value = ((bytes[0] * 0x1000000) + (bytes[1] * 0x10000) + (bytes[2] * 0x100) + bytes[3]) >>> 0
  return (value % 1_000_000).toString().padStart(6, '0')
}

function toMobilePairingRequest({connection: _connection, ...request}: PendingPairingRequest): MobilePairingRequest {
  return request
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length)
  combined.set(left)
  combined.set(right, left.length)
  return combined
}

function latin1ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index)
  return bytes
}

function asciiFromBytes(value: Uint8Array): string {
  return String.fromCharCode(...value)
}

function createServerFrame(payload: Uint8Array, opcode = 0x1): Uint8Array {
  const lengthBytes = payload.length < 126 ? 0 : 2
  const frame = new Uint8Array(2 + lengthBytes + payload.length)
  frame[0] = 0x80 | opcode
  if (lengthBytes === 0) {
    frame[1] = payload.length
    frame.set(payload, 2)
  } else {
    frame[1] = 126
    frame[2] = (payload.length >> 8) & 0xff
    frame[3] = payload.length & 0xff
    frame.set(payload, 4)
  }
  return frame
}

function indexOfHeaderEnd(value: Uint8Array): number {
  for (let index = 0; index <= value.length - 4; index += 1) {
    if (value[index] === 13 && value[index + 1] === 10 && value[index + 2] === 13 && value[index + 3] === 10) return index
  }
  return -1
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
