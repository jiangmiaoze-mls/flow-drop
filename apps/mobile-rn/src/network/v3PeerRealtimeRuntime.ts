import * as Crypto from 'expo-crypto'
import * as ExpoDevice from 'expo-device'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {AppState} from 'react-native'

import type {PeerHelloPayload, PeerMessage, TrustedDevice} from '@flowdrop/types'

import {getDeviceId} from '@/network/discoveryService'
import {startNativeIncomingTransfer, type NativeIncomingTransferStartConfig} from '@/network/nativeTransferController'
import {createV3IncomingTransfer} from '@/storage/v3IncomingTransferProjectionRepository'
import type {V3TextMessage} from '@/network/v3TextMessageClient'
import {getTransferSecret} from '@/storage/transferCredentialRepository'
import {saveReceivedTextMessages} from '@/storage/v3TextMessageRepository'
import {useTrustedDevicesStore} from '@/store/useTrustedDevicesStore'

const RECONNECT_DELAY_MS = 2_000

type Connection = {
  closed: boolean
  endpoint: string
  socket: WebSocket
}

export function startV3PeerRealtimeRuntime(options: {onError?: (error: Error) => void} = {}) {
  const connections = new Map<string, Connection>()
  let active = true
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const reconcile = () => {
    if (!active || AppState.currentState !== 'active') return
    const devices = useTrustedDevicesStore.getState().devices
    const eligible = new Map(devices.filter(canConnect).map((device) => [device.deviceId, device]))
    for (const [deviceId, connection] of connections) {
      const device = eligible.get(deviceId)
      if (device && endpointFor(device) === connection.endpoint) continue
      connection.closed = true
      connection.socket.close()
      connections.delete(deviceId)
    }
    for (const device of eligible.values()) {
      if (!connections.has(device.deviceId)) void connect(device)
    }
  }

  const scheduleReconcile = () => {
    if (!active || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconcile()
    }, RECONNECT_DELAY_MS)
  }

  const connect = async (device: TrustedDevice) => {
    const endpoint = endpointFor(device)
    const secret = await getTransferSecret(device.deviceId)
    const localDeviceId = await getDeviceId()
    if (!active || !secret || !/^[a-f0-9]{64}$/i.test(secret) || connections.has(device.deviceId)) return

    const socket = new WebSocket(endpoint)
    const connection: Connection = {closed: false, endpoint, socket}
    connections.set(device.deviceId, connection)
    const hello: PeerHelloPayload = {
      deviceId: localDeviceId,
      deviceKind: 'mobile',
      deviceName: ExpoDevice.deviceName?.trim() || ExpoDevice.modelName?.trim() || 'FlowDrop Mobile'
    }

    socket.onopen = () => {
      if (!isCurrentConnection(device.deviceId, connection)) return
      send(socket, {id: Crypto.randomUUID(), payload: hello, type: 'peer.hello', v: 1})
    }
    socket.onmessage = (event) => {
      if (!isCurrentConnection(device.deviceId, connection)) return
      void handleMessage(event.data, socket, device, hello, secret)
        .catch((error) => options.onError?.(toError(error)))
    }
    socket.onerror = () => undefined
    socket.onclose = () => {
      if (!isCurrentConnection(device.deviceId, connection)) return
      connections.delete(device.deviceId)
      if (!connection.closed) scheduleReconcile()
    }
  }

  const isCurrentConnection = (deviceId: string, connection: Connection) => (
    active && connections.get(deviceId) === connection && !connection.closed
  )

  const unsubscribe = useTrustedDevicesStore.subscribe(() => reconcile())
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') reconcile()
    else {
      for (const connection of connections.values()) {
        connection.closed = true
        connection.socket.close()
      }
      connections.clear()
    }
  })
  reconcile()

  return () => {
    active = false
    if (reconnectTimer) clearTimeout(reconnectTimer)
    unsubscribe()
    appStateSubscription.remove()
    for (const connection of connections.values()) {
      connection.closed = true
      connection.socket.close()
    }
    connections.clear()
  }
}

async function handleMessage(
  raw: unknown,
  socket: WebSocket,
  peer: TrustedDevice,
  hello: PeerHelloPayload,
  secret: string
) {
  const message = parse(raw)
  if (!message) return
  if (message.type === 'peer.ready') {
    send(socket, {
      id: Crypto.randomUUID(),
      payload: {authorization: createAuthorization(secret, hello)},
      type: 'peer.authenticate',
      v: 1
    })
    return
  }
  if (message.type === 'file.offer') {
    const offer = parseIncomingOffer(message.payload)
    if (!offer) return
    const incomingTransfer = await createV3IncomingTransfer({
      ...offer,
      peerAddress: peer.lastKnownAddress!,
      peerControlPort: peer.controlPort!,
      peerDeviceId: peer.deviceId
    })
    if (incomingTransfer.status === 'completed' || incomingTransfer.status === 'cancelled') return
    await startNativeIncomingTransfer({
      ...offer,
      peerAddress: peer.lastKnownAddress!,
      peerControlPort: peer.controlPort!,
      recipientDeviceId: hello.deviceId,
      transferSecretHex: secret
    })
    return
  }
  if (message.type !== 'message.changed' || !isTextMessage(message.payload)) return
  const localDeviceId = await getDeviceId()
  if (message.payload.recipientDeviceId !== localDeviceId) return
  await saveReceivedTextMessages(peer.deviceId, [message.payload], localDeviceId)
}

function canConnect(device: TrustedDevice) {
  return Boolean(device.lastKnownAddress && device.controlPort && device.receiveEnabled)
}

function endpointFor(device: TrustedDevice) {
  return `ws://${device.lastKnownAddress}:${device.controlPort}/v1/peer`
}

function createAuthorization(secret: string, hello: PeerHelloPayload) {
  const timestamp = Date.now().toString()
  const nonce = bytesToHex(Crypto.getRandomBytes(16))
  const body = new TextEncoder().encode(JSON.stringify({
    deviceId: hello.deviceId,
    deviceKind: hello.deviceKind,
    deviceName: hello.deviceName
  }))
  const bodyHash = bytesToHex(sha256(body))
  const signatureInput = new TextEncoder().encode(`WS\n/v1/peer\n${timestamp}\n${nonce}\n${bodyHash}`)
  const signature = bytesToHex(hmac(sha256, hexToBytes(secret), signatureInput))
  return `FlowDrop-HMAC ${timestamp}:${nonce}:${signature}`
}

function parse(value: unknown): PeerMessage | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object'
      && (parsed as {v?: unknown}).v === 1
      && typeof (parsed as {id?: unknown}).id === 'string'
      && typeof (parsed as {type?: unknown}).type === 'string'
      ? parsed as PeerMessage
      : null
  } catch {
    return null
  }
}

function send(socket: WebSocket, message: PeerMessage) {
  socket.send(JSON.stringify(message))
}

function isTextMessage(value: unknown): value is V3TextMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return typeof message.content === 'string'
    && typeof message.contentBytes === 'number'
    && typeof message.createdAt === 'number'
    && typeof message.messageId === 'string'
    && typeof message.recipientDeviceId === 'string'
    && typeof message.senderDeviceId === 'string'
    && typeof message.sequence === 'number'
}

function parseIncomingOffer(value: unknown): Omit<NativeIncomingTransferStartConfig, 'peerAddress' | 'peerControlPort' | 'recipientDeviceId' | 'transferSecretHex'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const offer = value as Record<string, unknown>
  if (
    typeof offer.transferId !== 'string'
    || !isIdentifier(offer.transferId)
    || !Number.isSafeInteger(offer.revision)
    || (offer.revision as number) < 0
    || !Number.isSafeInteger(offer.chunkSizeBytes)
    || (offer.chunkSizeBytes as number) < 1024 * 1024
    || (offer.chunkSizeBytes as number) > 4 * 1024 * 1024
    || !Array.isArray(offer.items)
    || offer.items.length < 1
    || offer.items.length > 32
  ) return null
  const items = offer.items.map((candidate) => parseIncomingOfferItem(candidate))
  if (items.some((item) => item === null)) return null
  if (new Set(items.map((item) => item!.itemId)).size !== items.length) return null
  return {
    chunkSizeBytes: offer.chunkSizeBytes as number,
    items: items as NativeIncomingTransferStartConfig['items'],
    revision: offer.revision as number,
    transferId: offer.transferId
  }
}

function parseIncomingOfferItem(value: unknown): NativeIncomingTransferStartConfig['items'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.itemId !== 'string'
    || !isIdentifier(item.itemId)
    || typeof item.name !== 'string'
    || item.name.length < 1
    || item.name.length > 255
    || /[<>:"/\\|?*\u0000-\u001f]/.test(item.name)
    || typeof item.mimeType !== 'string'
    || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(item.mimeType)
    || !Number.isSafeInteger(item.sizeBytes)
    || (item.sizeBytes as number) < 0
    || typeof item.contentRoot !== 'string'
    || !/^[a-f0-9]{64}$/.test(item.contentRoot)
  ) return null
  return item as NativeIncomingTransferStartConfig['items'][number]
}

function isIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('TEXT_REALTIME_SYNC_FAILED')
}
