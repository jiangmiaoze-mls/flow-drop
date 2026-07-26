import {randomUUID} from 'node:crypto'

import type {
  PeerHelloPayload,
  PeerMessage,
  PeerPairingRequestPayload,
  PeerPairingResolutionPayload,
  PeerPairingStatusPayload
} from '@flowdrop/types'

import type {PairingApprovalResolution, PairingService} from '../pairing/pairingService'
import {AgentEventBus} from './agentEventBus'


export type PeerSocket = {
  on: (event: 'close' | 'error' | 'message', listener: (...args: unknown[]) => void) => unknown
  send: (payload: string) => void
}

type PeerConnection = {
  device?: PeerHelloPayload
  id: string
  remoteAddress: string
  socket: PeerSocket
}

export class PeerConnectionManager {
  private readonly connections = new Map<string, PeerConnection>()
  private readonly deviceConnections = new Map<string, Set<string>>()

  constructor(
    private readonly agentEventBus: AgentEventBus,
    private readonly pairingService: PairingService
  ) {}

  closeAll() {
    this.connections.clear()
    this.deviceConnections.clear()
  }

  register(socket: PeerSocket, remoteAddress: string): string {
    const connection: PeerConnection = {
      id: randomUUID(),
      remoteAddress,
      socket
    }
    this.connections.set(connection.id, connection)

    socket.on('message', (message) => this.handleMessage(connection, message))
    socket.on('close', () => this.remove(connection.id))
    socket.on('error', () => this.remove(connection.id))
    return connection.id
  }

  sendPairingResolution(resolution: PairingApprovalResolution) {
    const payload: PeerPairingResolutionPayload = {
      requestId: resolution.request.requestId,
      status: resolution.status,
      transferSecret: resolution.transferSecret
    }
    this.agentEventBus.publish({
      payload: {...resolution.request, status: resolution.status},
      type: 'pairing.resolved'
    })

    if (resolution.requesterConnectionId) {
      this.send(resolution.requesterConnectionId, 'pairing.resolved', payload)
      return
    }

    const connectionIds = this.deviceConnections.get(resolution.request.deviceId) ?? new Set<string>()
    for (const connectionId of connectionIds) {
      this.send(connectionId, 'pairing.resolved', payload)
    }
  }

  private handleMessage(connection: PeerConnection, rawMessage: unknown) {
    const message = parsePeerMessage(rawMessage)
    if (!message) {
      this.sendError(connection.id, undefined, 'INVALID_MESSAGE')
      return
    }

    if (message.type === 'peer.hello') {
      if (!isPeerHelloPayload(message.payload)) {
        this.sendError(connection.id, message.id, 'INVALID_HELLO')
        return
      }
      this.identify(connection, message.payload)
      this.send(connection.id, 'peer.ready', {connectionId: connection.id}, message.id)
      return
    }

    if (!connection.device) {
      this.sendError(connection.id, message.id, 'HELLO_REQUIRED')
      return
    }

    if (message.type === 'pairing.request') {
      if (!isPeerPairingRequestPayload(message.payload)) {
        this.sendError(connection.id, message.id, 'INVALID_PAIRING_REQUEST')
        return
      }
      const result = this.pairingService.requestPairingApproval({
        code: message.payload.code,
        deviceId: connection.device.deviceId,
        deviceKind: connection.device.deviceKind,
        deviceName: connection.device.deviceName
      }, connection.remoteAddress, {
        requestId: message.id,
        requesterConnectionId: connection.id
      })
      if (result.status === 'invalid') {
        this.sendError(connection.id, message.id, 'INVALID_PAIRING_CODE')
        return
      }

      this.agentEventBus.publish({payload: result.request, type: 'pairing.requested'})
      this.send(connection.id, 'pairing.pending', result.request, message.id)
      return
    }

    if (message.type === 'pairing.status') {
      if (!isPeerPairingStatusPayload(message.payload)) {
        this.sendError(connection.id, message.id, 'INVALID_PAIRING_STATUS_REQUEST')
        return
      }

      const {requestId} = message.payload
      const status = this.pairingService.getPairingRequestStatus(requestId)
      if (!status) {
        this.sendError(connection.id, message.id, 'PAIRING_REQUEST_NOT_FOUND')
        return
      }
      if (status === 'pending') {
        this.pairingService.rebindPairingRequestConnection(requestId, connection.device.deviceId, connection.id)
        this.send(connection.id, 'pairing.pending', {requestId}, message.id)
        return
      }
      this.send(connection.id, 'pairing.resolved', {requestId, status}, message.id)
      return
    }

    this.sendError(connection.id, message.id, 'UNSUPPORTED_MESSAGE')
  }

  private identify(connection: PeerConnection, device: PeerHelloPayload) {
    if (connection.device?.deviceId === device.deviceId) return
    this.removeFromDeviceIndex(connection)
    connection.device = device
    const connectionIds = this.deviceConnections.get(device.deviceId) ?? new Set<string>()
    connectionIds.add(connection.id)
    this.deviceConnections.set(device.deviceId, connectionIds)
  }

  private remove(connectionId: string) {
    const connection = this.connections.get(connectionId)
    if (!connection) return

    this.removeFromDeviceIndex(connection)
    this.connections.delete(connectionId)
  }

  private removeFromDeviceIndex(connection: PeerConnection) {
    const deviceId = connection.device?.deviceId
    if (!deviceId) return

    const connectionIds = this.deviceConnections.get(deviceId)
    if (!connectionIds) return
    connectionIds.delete(connection.id)
    if (connectionIds.size === 0) this.deviceConnections.delete(deviceId)
  }

  private send(connectionId: string, type: string, payload: unknown, replyTo?: string) {
    const connection = this.connections.get(connectionId)
    if (!connection) return

    try {
      const message: PeerMessage = {id: randomUUID(), payload, replyTo, type, v: 1}
      connection.socket.send(JSON.stringify(message))
    } catch {
      this.remove(connectionId)
    }
  }

  private sendError(connectionId: string, replyTo: string | undefined, code: string) {
    this.send(connectionId, 'peer.error', {code}, replyTo)
  }
}

function parsePeerMessage(rawMessage: unknown): PeerMessage | null {
  const text = Buffer.isBuffer(rawMessage) ? rawMessage.toString('utf8') : rawMessage
  if (typeof text !== 'string') return null

  try {
    const payload: unknown = JSON.parse(text)
    if (!payload || typeof payload !== 'object') return null

    const message = payload as Record<string, unknown>
    return (
      message.v === 1 &&
      typeof message.id === 'string' && message.id.length > 0 &&
      typeof message.type === 'string' && message.type.length > 0
    ) ? payload as PeerMessage : null
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

function isPeerPairingRequestPayload(value: unknown): value is PeerPairingRequestPayload {
  return Boolean(value && typeof value === 'object' && /^\d{6}$/.test((value as {code?: unknown}).code as string))
}

function isPeerPairingStatusPayload(value: unknown): value is PeerPairingStatusPayload {
  return Boolean(value && typeof value === 'object' && typeof (value as {requestId?: unknown}).requestId === 'string')
}
