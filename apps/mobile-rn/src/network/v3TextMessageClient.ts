import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import * as Crypto from 'expo-crypto'

import {getDeviceId} from '@/network/discoveryService'
import {getTransferSecret} from '@/storage/transferCredentialRepository'

export const V3_TEXT_MESSAGE_MAX_BYTES = 1_500

export type V3TextMessage = {
  content: string
  contentBytes: number
  createdAt: number
  messageId: string
  recipientDeviceId: string
  senderDeviceId: string
  sequence: number
}

export type V3TextMessagePeer = {
  address: string
  deviceId: string
  controlPort: number
}

export class V3TextMessageError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'V3TextMessageError'
  }
}

export async function sendV3TextMessage(
  peer: V3TextMessagePeer,
  input: {content: string; messageId: string}
): Promise<V3TextMessage> {
  assertText(input.content)
  const sourceDeviceId = await getDeviceId()
  const body = canonicalizeJson({content: input.content, messageId: input.messageId, recipientDeviceId: peer.deviceId})
  const payload = await signedFetch(peer, sourceDeviceId, 'POST', '/v3/messages', body)
  const message = (payload as {message?: unknown}).message
  if (!isMessage(message)) throw new V3TextMessageError('TEXT_PROTOCOL_ERROR')
  return message
}

export async function pollV3TextMessages(
  peer: V3TextMessagePeer,
  after: number,
  limit = 100
): Promise<{messages: V3TextMessage[]; nextAfter: number}> {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new V3TextMessageError('INVALID_TEXT_MESSAGE_PAGE')
  }
  const sourceDeviceId = await getDeviceId()
  const path = `/v3/messages?after=${after}&limit=${limit}`
  const payload = await signedFetch(peer, sourceDeviceId, 'GET', path, '')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new V3TextMessageError('TEXT_PROTOCOL_ERROR')
  const page = payload as {messages?: unknown; nextAfter?: unknown}
  const {messages, nextAfter} = page
  if (!Array.isArray(messages) || typeof nextAfter !== 'number' || !Number.isSafeInteger(nextAfter) || nextAfter < after || !messages.every(isMessage)) {
    throw new V3TextMessageError('TEXT_PROTOCOL_ERROR')
  }
  return {messages, nextAfter}
}

export function textMessageByteLength(content: string) {
  return new TextEncoder().encode(content).length
}

function assertText(content: string) {
  const bytes = textMessageByteLength(content)
  if (bytes < 1 || bytes > V3_TEXT_MESSAGE_MAX_BYTES) throw new V3TextMessageError('INVALID_TEXT_MESSAGE')
}

async function signedFetch(
  peer: V3TextMessagePeer,
  sourceDeviceId: string,
  method: 'GET' | 'POST',
  path: string,
  body: string
): Promise<unknown> {
  const secret = await getTransferSecret(peer.deviceId)
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new V3TextMessageError('AUTHENTICATION_REQUIRED')
  const timestamp = Date.now().toString()
  const nonce = cryptoNonce()
  const bodyBytes = new TextEncoder().encode(body)
  const bodyHash = bytesToHex(sha256(bodyBytes))
  const signatureInput = new TextEncoder().encode(`${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`)
  const signature = bytesToHex(hmac(sha256, hexToBytes(secret), signatureInput))
  let response: Response
  try {
    response = await fetch(`http://${peer.address}:${peer.controlPort}${path}`, {
      body: method === 'POST' ? body : undefined,
      headers: {
        ...(method === 'POST' ? {'content-type': 'application/json'} : {}),
        authorization: `FlowDrop-HMAC ${timestamp}:${nonce}:${signature}`,
        'x-flowdrop-source-device-id': sourceDeviceId
      },
      method
    })
  } catch {
    throw new V3TextMessageError('TRANSFER_ENDPOINT_UNAVAILABLE')
  }
  const payload = await response.json().catch(() => null) as {code?: unknown} | null
  if (!response.ok) throw new V3TextMessageError(typeof payload?.code === 'string' ? payload.code : 'TEXT_ENDPOINT_UNAVAILABLE')
  return payload
}

function cryptoNonce() {
  return bytesToHex(Crypto.getRandomBytes(16))
}

function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`
  if (!value || typeof value !== 'object') throw new V3TextMessageError('INVALID_TEXT_MESSAGE')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(',')}}`
}

function isMessage(value: unknown): value is V3TextMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  return typeof message.content === 'string'
    && typeof message.contentBytes === 'number'
    && typeof message.createdAt === 'number'
    && typeof message.messageId === 'string'
    && typeof message.recipientDeviceId === 'string'
    && typeof message.senderDeviceId === 'string'
    && typeof message.sequence === 'number'
}
