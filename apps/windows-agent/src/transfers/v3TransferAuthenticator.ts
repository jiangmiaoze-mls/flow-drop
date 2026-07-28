import {createHash, createHmac, timingSafeEqual} from 'node:crypto'

import type {V3TrustedDeviceAccess} from './v3TrustedDeviceAccess'
import {V3TransportError} from './v3TransportError'

const MAX_CLOCK_SKEW_MS = 60_000
const NONCE_TTL_MS = 120_000
const MAX_TRACKED_NONCES = 16_384

export type V3HmacInput = {
  body: Buffer
  method: string
  nonce: string
  path: string
  timestamp: string
}

export type V3TransferAuthenticatorOptions = {
  maxTrackedNonces?: number
  nonceTtlMs?: number
  now?: () => number
}

export type V3AuthenticationFailureReason =
  | 'missing_or_malformed_headers'
  | 'stale_timestamp'
  | 'missing_transfer_credential'
  | 'nonce_replayed'
  | 'signature_mismatch'

export class V3AuthenticationError extends V3TransportError {
  constructor(public readonly reason: V3AuthenticationFailureReason) {
    super('AUTHENTICATION_REQUIRED', 401)
    this.name = 'V3AuthenticationError'
  }
}

type NonceExpiry = {
  expiresAt: number
  key: string
}

export class V3TransferAuthenticator {
  private readonly maxTrackedNonces: number
  private readonly nonceExpiryHeap: NonceExpiry[] = []
  private readonly nonceTtlMs: number
  private readonly now: () => number
  private readonly usedNonces = new Map<string, number>()

  constructor(
    private readonly trustedDeviceAccess: V3TrustedDeviceAccess,
    options: V3TransferAuthenticatorOptions = {}
  ) {
    this.maxTrackedNonces = assertPositiveInteger(options.maxTrackedNonces ?? MAX_TRACKED_NONCES, 'maximum nonce count')
    this.nonceTtlMs = assertPositiveInteger(options.nonceTtlMs ?? NONCE_TTL_MS, 'nonce TTL')
    this.now = options.now ?? Date.now
  }

  async authenticate(input: {
    authorization: unknown
    body: Buffer
    method: string
    path: string
    sourceDeviceId: unknown
  }): Promise<string> {
    const sourceDeviceId = getHeader(input.sourceDeviceId)
    const authorization = parseAuthorization(input.authorization)
    if (!sourceDeviceId || !authorization) throw new V3AuthenticationError('missing_or_malformed_headers')
    if (!isFreshTimestamp(authorization.timestamp, this.now())) throw new V3AuthenticationError('stale_timestamp')
    let access
    try {
      access = await this.trustedDeviceAccess.get(sourceDeviceId)
    } catch {
      throw new V3TransportError('AUTHENTICATION_UNAVAILABLE', 503)
    }
    if (!isFreshTimestamp(authorization.timestamp, this.now())) throw new V3AuthenticationError('stale_timestamp')
    const secret = access?.transferSecret
    if (!secret) throw new V3AuthenticationError('missing_transfer_credential')

    // The credential lookup is asynchronous, but nonce inspection and marking
    // remain in one synchronous continuation to make concurrent replays lose.
    const now = this.now()
    this.removeExpiredNonces(now)
    const nonceKey = JSON.stringify([sourceDeviceId, authorization.nonce])
    if (this.usedNonces.has(nonceKey)) throw new V3AuthenticationError('nonce_replayed')
    if (this.usedNonces.size >= this.maxTrackedNonces) {
      throw new V3TransportError('AUTHENTICATION_BACKPRESSURE', 503)
    }

    const expected = createV3RequestSignature(secret, {
      body: input.body,
      method: input.method,
      nonce: authorization.nonce,
      path: input.path,
      timestamp: authorization.timestamp
    })
    if (!isMatchingSignature(expected, authorization.signature)) {
      throw new V3AuthenticationError('signature_mismatch')
    }
    const expiresAt = now + this.nonceTtlMs
    this.usedNonces.set(nonceKey, expiresAt)
    this.pushNonceExpiry({expiresAt, key: nonceKey})
    return sourceDeviceId
  }

  private removeExpiredNonces(now: number) {
    while (this.nonceExpiryHeap.length > 0 && this.nonceExpiryHeap[0].expiresAt <= now) {
      const earliest = this.popNonceExpiry()
      if (earliest && this.usedNonces.get(earliest.key) === earliest.expiresAt) {
        this.usedNonces.delete(earliest.key)
      }
    }
  }

  private pushNonceExpiry(entry: NonceExpiry) {
    this.nonceExpiryHeap.push(entry)
    let index = this.nonceExpiryHeap.length - 1
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      const parent = this.nonceExpiryHeap[parentIndex]
      if (!parent || parent.expiresAt <= entry.expiresAt) break
      this.nonceExpiryHeap[index] = parent
      index = parentIndex
    }
    this.nonceExpiryHeap[index] = entry
  }

  private popNonceExpiry(): NonceExpiry | null {
    const earliest = this.nonceExpiryHeap[0]
    const last = this.nonceExpiryHeap.pop()
    if (!earliest) return null
    if (!last || this.nonceExpiryHeap.length === 0) return earliest

    let index = 0
    while (true) {
      const leftIndex = index * 2 + 1
      const rightIndex = leftIndex + 1
      const left = this.nonceExpiryHeap[leftIndex]
      const right = this.nonceExpiryHeap[rightIndex]
      if (!left) break
      const childIndex = right && right.expiresAt < left.expiresAt ? rightIndex : leftIndex
      const child = this.nonceExpiryHeap[childIndex]
      if (!child || child.expiresAt >= last.expiresAt) break
      this.nonceExpiryHeap[index] = child
      index = childIndex
    }
    this.nonceExpiryHeap[index] = last
    return earliest
  }
}

export function createV3RequestSignature(secretHex: string, input: V3HmacInput): string {
  if (!/^[a-f0-9]{64}$/i.test(secretHex)) throw new Error('Invalid V3 transfer credential.')
  const bodyHash = createHash('sha256').update(input.body).digest('hex')
  const message = Buffer.from(`${input.method}\n${input.path}\n${input.timestamp}\n${input.nonce}\n${bodyHash}`, 'utf8')
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message).digest('hex')
}

function parseAuthorization(value: unknown): {nonce: string; signature: string; timestamp: string} | null {
  const authorization = getHeader(value)
  if (!authorization) return null
  const match = /^FlowDrop-HMAC ((?:0|[1-9]\d{0,15})):([A-Za-z0-9._~-]{1,128}):([a-f0-9]{64})$/.exec(authorization)
  if (!match) return null
  return {nonce: match[2], signature: match[3], timestamp: match[1]}
}

function isFreshTimestamp(value: string, now: number): boolean {
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) && Math.abs(now - timestamp) <= MAX_CLOCK_SKEW_MS
}

function getHeader(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
}

function isMatchingSignature(expected: string, value: string): boolean {
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'))
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`V3 transfer authenticator ${label} must be a positive safe integer.`)
  }
  return value
}
