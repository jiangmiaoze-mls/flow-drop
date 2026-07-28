import {mkdirSync} from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {parentPort, workerData} from 'node:worker_threads'

import {V3TransportError} from './v3TransportError'
import {migrateV3TextMessageDatabase} from './v3TextMessageMigration'
import {V3_TEXT_MESSAGE_MAX_BYTES, type V3TextMessage, type V3TextMessagePage} from './v3TextMessageTypes'

type Request =
  | {message: {content: string; messageId: string; recipientDeviceId: string; senderDeviceId: string}; type: 'append'}
  | {after: number; limit: number; recipientDeviceId: string; type: 'listForRecipient'}
  | {agentDeviceId: string; limit: number; peerDeviceId: string; type: 'listConversation'}
  | {type: 'close'}

type Row = {
  content: string
  content_bytes: number
  created_at: number
  message_id: string
  recipient_device_id: string
  sender_device_id: string
  sequence: number
}

const rootDirectory = readRootDirectory(workerData)
mkdirSync(rootDirectory, {recursive: true})
const database = new DatabaseSync(path.join(rootDirectory, 'text-messages.sqlite'))
database.exec('PRAGMA journal_mode = WAL')
migrateV3TextMessageDatabase(database)

const port = parentPort
if (!port) throw new Error('V3 text message worker has no parent port.')
let closed = false
port.on('message', (raw: unknown) => {
  if (!isRequest(raw)) return
  const response: {error?: {code?: string; message: string; statusCode?: number}; id: number; result?: unknown} = {id: raw.id}
  try {
    response.result = handle(raw.payload)
  } catch (error) {
    response.error = serialize(error)
  }
  port.postMessage(response)
})
port.postMessage({type: 'ready'})

function handle(request: Request): V3TextMessage | V3TextMessage[] | V3TextMessagePage | null {
  if (closed && request.type !== 'close') throw new V3TransportError('TEXT_STORAGE_CLOSED', 503)
  switch (request.type) {
    case 'append': return append(request.message)
    case 'listForRecipient': return listForRecipient(request.recipientDeviceId, request.after, request.limit)
    case 'listConversation': return listConversation(request.agentDeviceId, request.peerDeviceId, request.limit)
    case 'close':
      closed = true
      database.close()
      return null
  }
}

function append(message: {content: string; messageId: string; recipientDeviceId: string; senderDeviceId: string}): V3TextMessage {
  const bytes = Buffer.byteLength(message.content, 'utf8')
  if (!isId(message.messageId) || !isId(message.senderDeviceId) || !isId(message.recipientDeviceId) || bytes < 1 || bytes > V3_TEXT_MESSAGE_MAX_BYTES) {
    throw new V3TransportError('INVALID_TEXT_MESSAGE', 400)
  }
  const existing = database.prepare('SELECT * FROM v3_text_messages WHERE message_id = ?').get(message.messageId) as Row | undefined
  if (existing) {
    if (existing.sender_device_id !== message.senderDeviceId || existing.recipient_device_id !== message.recipientDeviceId || existing.content !== message.content) {
      throw new V3TransportError('TEXT_MESSAGE_ID_CONFLICT', 409)
    }
    return toMessage(existing)
  }
  const now = Date.now()
  database.prepare(`
    INSERT INTO v3_text_messages (message_id, sender_device_id, recipient_device_id, content, content_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(message.messageId, message.senderDeviceId, message.recipientDeviceId, message.content, bytes, now)
  const row = database.prepare('SELECT * FROM v3_text_messages WHERE message_id = ?').get(message.messageId) as Row
  return toMessage(row)
}

function listForRecipient(recipientDeviceId: string, after: number, limit: number): V3TextMessagePage {
  if (!isId(recipientDeviceId) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new V3TransportError('INVALID_TEXT_MESSAGE_PAGE', 400)
  }
  const rows = database.prepare(`
    SELECT * FROM v3_text_messages
    WHERE recipient_device_id = ? AND sequence > ?
    ORDER BY sequence ASC LIMIT ?
  `).all(recipientDeviceId, after, limit) as Row[]
  const messages = rows.map(toMessage)
  return {messages, nextAfter: messages.length > 0 ? messages[messages.length - 1].sequence : after}
}

function listConversation(agentDeviceId: string, peerDeviceId: string, limit: number): V3TextMessage[] {
  if (!isId(agentDeviceId) || !isId(peerDeviceId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new V3TransportError('INVALID_TEXT_MESSAGE_PAGE', 400)
  }
  return (database.prepare(`
    SELECT * FROM v3_text_messages
    WHERE (sender_device_id = ? AND recipient_device_id = ?)
       OR (sender_device_id = ? AND recipient_device_id = ?)
    ORDER BY sequence DESC LIMIT ?
  `).all(agentDeviceId, peerDeviceId, peerDeviceId, agentDeviceId, limit) as Row[]).reverse().map(toMessage)
}

function toMessage(row: Row): V3TextMessage {
  return {
    content: row.content,
    contentBytes: row.content_bytes,
    createdAt: row.created_at,
    messageId: row.message_id,
    recipientDeviceId: row.recipient_device_id,
    senderDeviceId: row.sender_device_id,
    sequence: row.sequence
  }
}

function isRequest(value: unknown): value is {id: number; payload: Request} {
  return Boolean(value && typeof value === 'object' && Number.isSafeInteger((value as {id?: unknown}).id) && 'payload' in value)
}

function isId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function readRootDirectory(value: unknown) {
  const root = (value as {rootDirectory?: unknown})?.rootDirectory
  if (typeof root !== 'string' || root.length === 0) throw new Error('V3 text message worker requires a root directory.')
  return root
}

function serialize(error: unknown) {
  if (error instanceof V3TransportError) return {code: error.code, message: error.message, statusCode: error.statusCode}
  return {message: error instanceof Error ? error.message : 'V3 text message worker failed.'}
}
