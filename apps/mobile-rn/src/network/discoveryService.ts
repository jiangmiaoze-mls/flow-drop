import * as Application from 'expo-application'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import {DISCOVERY_BROADCAST_ADDRESS, DISCOVERY_PORT} from '@flowdrop/config'
import type {
  DiscoveryAnnouncement,
  DiscoveryEvent,
  DiscoveryEventListener,
  DiscoveryServiceOptions,
  DiscoveredDevice,
} from '@flowdrop/types'
import dgram, {type RemoteInfo, type Socket} from 'react-native-udp'
import {Platform} from 'react-native'


const PROTOCOL = 'flowdrop-discovery'
const PROTOCOL_VERSION = 1
const IOS_DEVICE_ID_KEY = 'flowdrop.device-id.v1'
const DEFAULT_ANNOUNCE_INTERVAL_MS = 3_000
const DEFAULT_DEVICE_TTL_MS = 10_000
const MAX_MESSAGE_BYTES = 4_096
const MAX_DEVICE_ID_LENGTH = 128
const MAX_DEVICE_NAME_LENGTH = 128

let iosDeviceIdPromise: Promise<string> | null = null

export type {
  DiscoveryAnnouncement,
  DiscoveryEvent,
  DiscoveryEventListener,
  DiscoveryServiceOptions,
  DiscoveredDevice,
} from '@flowdrop/types'

/**
 * Discovers nearby FlowDrop peers over IPv4 broadcast.
 *
 * The device ID is created inside this service: Android uses ANDROID_ID, while
 * iOS persists a cryptographically random UUID in the Keychain via SecureStore.
 */
export class DiscoveryService {
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private readonly devices = new Map<string, DiscoveredDevice>()
  private deviceIdValue: string | null = null
  private readonly eventListeners = new Set<DiscoveryEventListener>()
  private generation = 0
  private running = false
  private socket: Socket | null = null
  private startPromise: Promise<void> | null = null
  private cancelPendingBind: (() => void) | null = null

  private readonly announceIntervalMs: number
  private readonly broadcastAddress: string
  private readonly deviceTtlMs: number
  private readonly port: number

  constructor(
    private readonly deviceName: string,
    options: DiscoveryServiceOptions = {}
  ) {
    if (!isValidDeviceName(deviceName)) {
      throw new Error(`deviceName must be a non-empty string up to ${MAX_DEVICE_NAME_LENGTH} characters.`)
    }

    this.announceIntervalMs = options.announceIntervalMs ?? DEFAULT_ANNOUNCE_INTERVAL_MS
    this.broadcastAddress = options.broadcastAddress ?? DISCOVERY_BROADCAST_ADDRESS
    this.deviceTtlMs = options.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS
    this.port = options.port ?? DISCOVERY_PORT
    validateOptions(this.announceIntervalMs, this.deviceTtlMs, this.port, this.broadcastAddress)
  }

  get deviceId(): string | null {
    return this.deviceIdValue
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve()
    if (this.startPromise) return this.startPromise

    const generation = ++this.generation
    let startPromise!: Promise<void>
    startPromise = (async () => {
      try {
        await this.startInternal(generation)
      } finally {
        if (this.startPromise === startPromise) {
          this.startPromise = null
        }
      }
    })()

    this.startPromise = startPromise
    return startPromise
  }

  stop(): void {
    this.generation += 1
    this.running = false
    this.cancelPendingBind?.()
    this.cancelPendingBind = null

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
    if (socket) {
      socket.removeListener('message', this.handleMessage)
      socket.close(() => socket.removeListener('error', this.handleSocketError))
    }

    this.devices.clear()
  }

  announce(): void {
    if (!this.running || !this.socket || !this.deviceIdValue) return

    const payload: DiscoveryAnnouncement = {
      deviceId: this.deviceIdValue,
      deviceName: this.deviceName,
      protocol: PROTOCOL,
      type: 'announce',
      version: PROTOCOL_VERSION
    }

    try {
      // react-native-udp follows the legacy Node dgram argument order.
      this.socket.send(
        JSON.stringify(payload),
        undefined,
        undefined,
        this.port,
        this.broadcastAddress,
        (error) => {
          if (error) this.emit({type: 'error', error})
        }
      )
    } catch (error) {
      this.emit({type: 'error', error: toError(error)})
    }
  }

  getDiscoveredDevices(): DiscoveredDevice[] {
    return [...this.devices.values()]
      .map(cloneDevice)
      .sort((left, right) => left.deviceName.localeCompare(right.deviceName))
  }

  subscribe(listener: DiscoveryEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  private async startInternal(generation: number): Promise<void> {
    const deviceId = await getDeviceId()
    this.throwIfStopped(generation)
    this.deviceIdValue = deviceId

    const socket = dgram.createSocket({type: 'udp4', reusePort: true})
    this.socket = socket
    socket.on('message', this.handleMessage)
    socket.on('error', this.handleSocketError)

    try {
      await this.bind(socket)
      this.throwIfStopped(generation)
      socket.setBroadcast(true)
      this.running = true
      this.announce()
      this.announceTimer = setInterval(() => this.announce(), this.announceIntervalMs)
      this.cleanupTimer = setInterval(() => this.removeExpiredDevices(), this.announceIntervalMs)
    } catch (error) {
      if (this.socket === socket) this.socket = null
      socket.removeListener('message', this.handleMessage)
      socket.close(() => socket.removeListener('error', this.handleSocketError))
      throw toError(error)
    }
  }

  private bind(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.removeListener('listening', handleListening)
        socket.removeListener('error', handleError)
        if (this.cancelPendingBind === cancel) this.cancelPendingBind = null
      }
      const handleListening = () => {
        cleanup()
        resolve()
      }
      const handleError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cancel = () => {
        cleanup()
        reject(new Error('Discovery service was stopped before binding completed.'))
      }

      this.cancelPendingBind = cancel
      socket.once('listening', handleListening)
      socket.once('error', handleError)

      try {
        socket.bind(this.port, '0.0.0.0')
      } catch (error) {
        handleError(toError(error))
      }
    })
  }

  private throwIfStopped(generation: number) {
    if (generation !== this.generation) {
      throw new Error('Discovery service was stopped before it finished starting.')
    }
  }

  private handleMessage = (message: {
    length: number;
    toString: (encoding?: string) => string
  }, remote: RemoteInfo) => {
    if (message.length > MAX_MESSAGE_BYTES) return

    const announcement = parseAnnouncement(message)
    if (!announcement || announcement.deviceId === this.deviceIdValue) return

    const device: DiscoveredDevice = {
      address: remote.address,
      deviceId: announcement.deviceId,
      deviceName: announcement.deviceName,
      lastSeenAt: Date.now(),
      port: remote.port
    }
    const previous = this.devices.get(device.deviceId)
    this.devices.set(device.deviceId, device)

    if (!previous) {
      this.emit({type: 'deviceFound', device})
      return
    }

    if (
      previous.address !== device.address ||
      previous.deviceName !== device.deviceName ||
      previous.port !== device.port
    ) {
      this.emit({type: 'deviceUpdated', device})
    }
  }

  private handleSocketError = (error: Error) => {
    this.emit({type: 'error', error})
  }

  private removeExpiredDevices() {
    const expiresBefore = Date.now() - this.deviceTtlMs

    for (const [deviceId, device] of this.devices) {
      if (device.lastSeenAt > expiresBefore) continue
      this.devices.delete(deviceId)
      this.emit({type: 'deviceLost', device})
    }
  }

  private emit(event: DiscoveryEvent) {
    const copy = 'device' in event ? {...event, device: cloneDevice(event.device)} : event

    for (const listener of this.eventListeners) {
      listener(copy)
    }
  }
}

async function getDeviceId(): Promise<string> {
  if (Platform.OS === 'android') {
    const androidId = Application.getAndroidId()
    if (!isValidDeviceId(androidId)) {
      throw new Error('Unable to retrieve a valid Android device ID.')
    }
    return androidId
  }

  if (Platform.OS === 'ios') {
    return getOrCreateIosDeviceId()
  }

  throw new Error('DiscoveryService supports Android and iOS only.')
}

async function getOrCreateIosDeviceId(): Promise<string> {
  if (iosDeviceIdPromise) return iosDeviceIdPromise

  const promise = (async () => {
    const storedId = await SecureStore.getItemAsync(IOS_DEVICE_ID_KEY)
    if (isValidDeviceId(storedId)) return storedId

    const generatedId = Crypto.randomUUID()
    await SecureStore.setItemAsync(IOS_DEVICE_ID_KEY, generatedId, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
    })
    return generatedId
  })()

  iosDeviceIdPromise = promise
  try {
    return await promise
  } catch (error) {
    if (iosDeviceIdPromise === promise) iosDeviceIdPromise = null
    throw error
  }
}

function parseAnnouncement(message: { toString: (encoding?: string) => string }): DiscoveryAnnouncement | null {
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

function validateOptions(
  announceIntervalMs: number,
  deviceTtlMs: number,
  port: number,
  broadcastAddress: string
) {
  if (!Number.isFinite(announceIntervalMs) || announceIntervalMs <= 0) {
    throw new Error('announceIntervalMs must be greater than zero.')
  }
  if (!Number.isFinite(deviceTtlMs) || deviceTtlMs <= announceIntervalMs) {
    throw new Error('deviceTtlMs must be greater than announceIntervalMs.')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('port must be an integer between 1 and 65535.')
  }
  if (!broadcastAddress.trim()) {
    throw new Error('broadcastAddress must not be empty.')
  }
}

function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_DEVICE_ID_LENGTH
}

function isValidDeviceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_DEVICE_NAME_LENGTH
}

function cloneDevice(device: DiscoveredDevice): DiscoveredDevice {
  return {...device}
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
