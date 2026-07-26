import {createSocket, type RemoteInfo, type Socket} from 'node:dgram'
import os from 'node:os'
import {machineId} from 'node-machine-id'

import {DISCOVERY_BROADCAST_ADDRESS, DISCOVERY_PORT, PAIRING_CONTROL_PORT} from '@flowdrop/config'
import {getIPv4BroadcastTargets} from '@flowdrop/network'
import type {DiscoveryAnnouncement, DiscoveryEvent, DiscoveredDevice} from '@flowdrop/types'


const PROTOCOL = 'flowdrop-discovery'
const PROTOCOL_VERSION = 1
const DEFAULT_ANNOUNCE_INTERVAL_MS = 3_000
const DEFAULT_DEVICE_TTL_MS = 10_000
const MAX_MESSAGE_BYTES = 4_096
const MAX_DEVICE_ID_LENGTH = 128
const MAX_DEVICE_NAME_LENGTH = 128

export type DiscoveryBroadcasterOptions = {
  announceIntervalMs?: number
  broadcastAddress?: string
  deviceTtlMs?: number
  deviceName?: string
  onDiscoveryEvent?: (event: DiscoveryEvent) => void
  onError?: (error: Error) => void
  port?: number
}

export class DiscoveryBroadcaster {
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private deviceIdValue: string | null = null
  private readonly devices = new Map<string, DiscoveredDevice>()
  private generation = 0
  private running = false
  private socket: Socket | null = null
  private startPromise: Promise<void> | null = null

  private readonly announceIntervalMs: number
  private readonly broadcastAddress: string
  private readonly deviceTtlMs: number
  private readonly deviceName: string
  private readonly onDiscoveryEvent: (event: DiscoveryEvent) => void
  private readonly onError: (error: Error) => void
  private readonly port: number

  constructor(options: DiscoveryBroadcasterOptions = {}) {
    this.announceIntervalMs = options.announceIntervalMs ?? DEFAULT_ANNOUNCE_INTERVAL_MS
    this.broadcastAddress = options.broadcastAddress ?? DISCOVERY_BROADCAST_ADDRESS
    this.deviceTtlMs = options.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS
    this.deviceName = options.deviceName ?? getDefaultDeviceName()
    this.onDiscoveryEvent = options.onDiscoveryEvent ?? (() => undefined)
    this.onError = options.onError ?? (() => undefined)
    this.port = options.port ?? DISCOVERY_PORT

    validateOptions(
      this.announceIntervalMs,
      this.broadcastAddress,
      this.deviceTtlMs,
      this.deviceName,
      this.port
    )
  }

  get deviceId(): string | null {
    return this.deviceIdValue
  }

  get isRunning(): boolean {
    return this.running
  }

  getDiscoveredDevices(): DiscoveredDevice[] {
    return [...this.devices.values()]
      .map((device) => ({...device}))
      .sort((left, right) => left.deviceName.localeCompare(right.deviceName))
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve()
    if (this.startPromise) return this.startPromise

    const generation = ++this.generation
    let startPromise!: Promise<void>
    startPromise = this.startInternal(generation).finally(() => {
      if (this.startPromise === startPromise) this.startPromise = null
    })
    this.startPromise = startPromise
    return startPromise
  }

  async stop(): Promise<void> {
    this.generation += 1
    this.running = false

    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    const socket = this.socket
    this.socket = null
    if (socket) await closeSocket(socket)
    this.devices.clear()
  }

  private async startInternal(generation: number): Promise<void> {
    // node-machine-id returns a SHA-256 hash unless explicitly asked for the raw machine ID.
    const deviceId = await machineId()
    if (!isValidDeviceId(deviceId)) {
      throw new Error('Unable to retrieve a valid machine ID.')
    }
    this.throwIfStopped(generation)
    this.deviceIdValue = deviceId

    const socket = createSocket({type: 'udp4', reuseAddr: true})
    socket.on('error', (error) => this.onError(error))
    socket.on('message', this.handleMessage)
    this.socket = socket

    try {
      await bindSocket(socket, this.port)
      this.throwIfStopped(generation)
      socket.setBroadcast(true)
      this.running = true
      this.announce()
      this.announceTimer = setInterval(() => this.announce(), this.announceIntervalMs)
      this.cleanupTimer = setInterval(() => this.removeExpiredDevices(), this.announceIntervalMs)
    } catch (error) {
      if (this.socket === socket) this.socket = null
      socket.removeListener('message', this.handleMessage)
      await closeSocket(socket)
      throw toError(error)
    }
  }

  private announce(): void {
    if (!this.running || !this.socket || !this.deviceIdValue) return

    const directedBroadcastAddresses = getIPv4BroadcastTargets()
      .map((target) => target.broadcastAddress)
    const broadcastAddresses = directedBroadcastAddresses.length > 0
      ? directedBroadcastAddresses
      : [this.broadcastAddress]

    for (const broadcastAddress of broadcastAddresses) {
      this.sendAnnouncement(broadcastAddress, this.port)
    }
  }

  private sendAnnouncement(address: string, port: number): void {
    if (!this.socket || !this.deviceIdValue) return

    const announcement: DiscoveryAnnouncement = {
      controlPort: PAIRING_CONTROL_PORT,
      deviceId: this.deviceIdValue,
      deviceName: this.deviceName,
      pairingAvailable: true,
      protocol: PROTOCOL,
      type: 'announce',
      version: PROTOCOL_VERSION
    }

    try {
      this.socket.send(JSON.stringify(announcement), port, address, (error) => {
        if (error) this.onError(error)
      })
    } catch (error) {
      this.onError(toError(error))
    }
  }

  private handleMessage = (message: Buffer, remote: RemoteInfo) => {
    if (message.length > MAX_MESSAGE_BYTES) return

    const announcement = parseAnnouncement(message)
    if (!announcement || announcement.deviceId === this.deviceIdValue) return

    // A unicast response avoids depending solely on Wi-Fi broadcast delivery
    // after the Agent has already received a mobile discovery announcement.
    if (!announcement.pairingAvailable) {
      this.sendAnnouncement(remote.address, remote.port)
    }

    const device: DiscoveredDevice = {
      address: remote.address,
      controlPort: announcement.controlPort,
      deviceId: announcement.deviceId,
      deviceName: announcement.deviceName,
      lastSeenAt: Date.now(),
      port: remote.port
    }
    const previous = this.devices.get(device.deviceId)
    this.devices.set(device.deviceId, device)

    if (!previous) {
      this.emitDiscoveryEvent({type: 'deviceFound', device})
      return
    }
    if (
      previous.address !== device.address ||
      previous.controlPort !== device.controlPort ||
      previous.deviceName !== device.deviceName ||
      previous.port !== device.port
    ) {
      this.emitDiscoveryEvent({type: 'deviceUpdated', device})
    }
  }

  private removeExpiredDevices() {
    const expiresBefore = Date.now() - this.deviceTtlMs

    for (const [deviceId, device] of this.devices) {
      if (device.lastSeenAt > expiresBefore) continue
      this.devices.delete(deviceId)
      this.emitDiscoveryEvent({type: 'deviceLost', device})
    }
  }

  private emitDiscoveryEvent(event: DiscoveryEvent) {
    const copy = 'device' in event ? {...event, device: {...event.device}} : event
    this.onDiscoveryEvent(copy)
  }

  private throwIfStopped(generation: number) {
    if (generation !== this.generation) {
      throw new Error('Discovery broadcaster was stopped before it finished starting.')
    }
  }
}

function getDefaultDeviceName(): string {
  const deviceName = os.hostname().trim()
  return isValidDeviceName(deviceName) ? deviceName : 'FlowDrop Agent'
}

function bindSocket(socket: Socket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener('error', handleError)
      socket.removeListener('listening', handleListening)
    }
    const handleError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const handleListening = () => {
      cleanup()
      resolve()
    }

    socket.once('error', handleError)
    socket.once('listening', handleListening)
    socket.bind({address: '0.0.0.0', port})
  })
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

function validateOptions(
  announceIntervalMs: number,
  broadcastAddress: string,
  deviceTtlMs: number,
  deviceName: string,
  port: number
) {
  if (!Number.isFinite(announceIntervalMs) || announceIntervalMs <= 0) {
    throw new Error('announceIntervalMs must be greater than zero.')
  }
  if (!broadcastAddress.trim()) {
    throw new Error('broadcastAddress must not be empty.')
  }
  if (!Number.isFinite(deviceTtlMs) || deviceTtlMs <= announceIntervalMs) {
    throw new Error('deviceTtlMs must be greater than announceIntervalMs.')
  }
  if (!isValidDeviceName(deviceName)) {
    throw new Error(`deviceName must be a non-empty string up to ${MAX_DEVICE_NAME_LENGTH} characters.`)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('port must be an integer between 1 and 65535.')
  }
}

function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_DEVICE_ID_LENGTH
}

function isValidDeviceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_DEVICE_NAME_LENGTH
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function parseAnnouncement(message: Buffer): DiscoveryAnnouncement | null {
  try {
    const payload: unknown = JSON.parse(message.toString('utf8'))
    return isDiscoveryAnnouncement(payload) ? payload : null
  } catch {
    return null
  }
}

function isDiscoveryAnnouncement(value: unknown): value is DiscoveryAnnouncement {
  if (!value || typeof value !== 'object') return false

  const payload = value as Record<string, unknown>
  return (
    payload.protocol === PROTOCOL &&
    payload.version === PROTOCOL_VERSION &&
    payload.type === 'announce' &&
    isValidDeviceId(payload.deviceId) &&
    isValidDeviceName(payload.deviceName)
  )
}
