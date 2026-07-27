import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createV3RequestSignature,
  V3TransferAuthenticator
} from '../src/transfers/v3TransferAuthenticator'

const DEVICE_ID = 'device-001'
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

test('bounds tracked V3 nonces and reclaims them by expiry without a full-map sweep', async () => {
  let now = 10_000
  const authenticator = new V3TransferAuthenticator({
    get: async () => ({receiveEnabled: true, transferSecret: SECRET})
  }, {
    maxTrackedNonces: 2,
    nonceTtlMs: 100,
    now: () => now
  })

  await authenticator.authenticate(createAuthenticationInput('nonce-1', now))
  await authenticator.authenticate(createAuthenticationInput('nonce-2', now))
  await assert.rejects(
    authenticator.authenticate(createAuthenticationInput('nonce-3', now)),
    (error: unknown) => isTransportError(error, 'AUTHENTICATION_BACKPRESSURE', 503)
  )

  now += 101
  await assert.doesNotReject(authenticator.authenticate(createAuthenticationInput('nonce-3', now)))
})

test('returns a retryable response when asynchronous credential access is unavailable', async () => {
  const authenticator = new V3TransferAuthenticator({
    get: async () => {
      throw new Error('trusted-device worker unavailable')
    }
  })

  await assert.rejects(
    authenticator.authenticate(createAuthenticationInput('nonce-unavailable', Date.now())),
    (error: unknown) => isTransportError(error, 'AUTHENTICATION_UNAVAILABLE', 503)
  )
})

function createAuthenticationInput(nonce: string, timestamp: number) {
  const body = Buffer.alloc(0)
  const path = '/v1/transport/capabilities'
  const timestampText = timestamp.toString()
  const signature = createV3RequestSignature(SECRET, {
    body,
    method: 'GET',
    nonce,
    path,
    timestamp: timestampText
  })
  return {
    authorization: `FlowDrop-HMAC ${timestampText}:${nonce}:${signature}`,
    body,
    method: 'GET',
    path,
    sourceDeviceId: DEVICE_ID
  }
}

function isTransportError(value: unknown, code: string, statusCode: number) {
  return value !== null
    && typeof value === 'object'
    && (value as {code?: unknown}).code === code
    && (value as {statusCode?: unknown}).statusCode === statusCode
}
