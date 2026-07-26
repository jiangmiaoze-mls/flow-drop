import {createHash, createHmac, timingSafeEqual} from 'node:crypto'

import type {TrustedDeviceStore} from '../storage/trustedDeviceStore'
import {TransferServiceError} from './transferService'


const MAX_CLOCK_SKEW_MS = 60_000
const NONCE_TTL_MS = 120_000

export class TransferAuthenticator {
  private readonly usedNonces = new Map<string, number>()

  constructor(private readonly trustedDeviceStore: TrustedDeviceStore) {}

  authenticate(input: {body: Buffer | string; method: string; nonce: unknown; path: string; signature: unknown; sourceDeviceId: unknown; timestamp: unknown}): string {
    const sourceDeviceId = getHeader(input.sourceDeviceId)
    const nonce = getHeader(input.nonce)
    const signature = getHeader(input.signature)
    const timestamp = Number(input.timestamp)
    if (!sourceDeviceId || !nonce || !signature || !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
      throw new TransferServiceError('AUTHENTICATION_REQUIRED', 401)
    }
    const secret = this.trustedDeviceStore.getTransferSecret(sourceDeviceId)
    if (!secret) throw new TransferServiceError('AUTHENTICATION_REQUIRED', 401)

    this.removeExpiredNonces()
    const nonceKey = `${sourceDeviceId}:${nonce}`
    if (this.usedNonces.has(nonceKey)) throw new TransferServiceError('AUTHENTICATION_REQUIRED', 401)
    const bodyHash = createHash('sha256').update(input.body).digest('hex')
    const expected = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(`${input.method}\n${input.path}\n${timestamp}\n${nonce}\n${bodyHash}`)
      .digest('hex')
    if (!isMatchingSignature(expected, signature)) throw new TransferServiceError('AUTHENTICATION_REQUIRED', 401)
    this.usedNonces.set(nonceKey, Date.now() + NONCE_TTL_MS)
    return sourceDeviceId
  }

  private removeExpiredNonces() {
    const now = Date.now()
    for (const [nonce, expiresAt] of this.usedNonces) if (expiresAt <= now) this.usedNonces.delete(nonce)
  }
}

function getHeader(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

function isMatchingSignature(expected: string, value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'))
}
