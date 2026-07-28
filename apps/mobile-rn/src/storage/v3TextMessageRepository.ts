import type {V3TextMessage} from '@/network/v3TextMessageClient'
import {withV3TransferProjectionDatabaseAccess} from './v3TransferProjectionRepository'

export type LocalTextMessage = V3TextMessage & {
  deliveryState: 'failed' | 'received' | 'sending' | 'sent'
  peerDeviceId: string
}

const changeObservers = new Set<() => void>()

export function subscribeToLocalTextMessageChanges(observer: () => void) {
  changeObservers.add(observer)
  return () => changeObservers.delete(observer)
}

type Row = {
  content: string
  content_bytes: number
  created_at: number
  delivery_state: LocalTextMessage['deliveryState']
  message_id: string
  peer_device_id: string
  recipient_device_id: string
  sender_device_id: string
  sequence: number
}

export async function listLocalTextMessages(peerDeviceId: string): Promise<LocalTextMessage[]> {
  return withV3TransferProjectionDatabaseAccess(async (database) => {
    const rows = await database.getAllAsync<Row>(`
      SELECT * FROM v3_text_messages WHERE peer_device_id = ?
      ORDER BY CASE WHEN sequence = 0 THEN created_at ELSE sequence END ASC, created_at ASC
    `, peerDeviceId)
    return rows.map(toMessage)
  })
}

export async function listAllLocalTextMessages(): Promise<LocalTextMessage[]> {
  return withV3TransferProjectionDatabaseAccess(async (database) => {
    const rows = await database.getAllAsync<Row>(`
      SELECT * FROM v3_text_messages
      ORDER BY CASE WHEN sequence = 0 THEN created_at ELSE sequence END DESC, created_at DESC
    `)
    return rows.map(toMessage)
  })
}

export async function latestTextMessageCursor(peerDeviceId: string, localDeviceId: string): Promise<number> {
  return withV3TransferProjectionDatabaseAccess(async (database) => {
    const row = await database.getFirstAsync<{sequence: number}>(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM v3_text_messages
      WHERE peer_device_id = ? AND recipient_device_id = ?
    `, peerDeviceId, localDeviceId)
    return row?.sequence ?? 0
  })
}

export async function saveOutgoingTextMessage(message: LocalTextMessage) {
  await upsert(message)
}

export async function saveReceivedTextMessages(peerDeviceId: string, messages: V3TextMessage[], localDeviceId: string) {
  for (const message of messages) {
    await upsert({...message, deliveryState: message.recipientDeviceId === localDeviceId ? 'received' : 'sent', peerDeviceId})
  }
}

export async function markTextMessageDelivery(message: V3TextMessage, peerDeviceId: string) {
  await upsert({...message, deliveryState: 'sent', peerDeviceId})
}

export async function markTextMessageFailed(messageId: string) {
  await withV3TransferProjectionDatabaseAccess((database) => database.runAsync(
    "UPDATE v3_text_messages SET delivery_state = 'failed' WHERE message_id = ?", messageId
  ).then(() => undefined))
}

export async function deleteLocalTextMessage(messageId: string): Promise<void> {
  await withV3TransferProjectionDatabaseAccess((database) => database.runAsync(
    'DELETE FROM v3_text_messages WHERE message_id = ?', messageId
  ).then(() => undefined))
  for (const observer of changeObservers) observer()
}

async function upsert(message: LocalTextMessage) {
  await withV3TransferProjectionDatabaseAccess((database) => database.runAsync(`
      INSERT INTO v3_text_messages (
        message_id, peer_device_id, sender_device_id, recipient_device_id, content, content_bytes,
        created_at, sequence, delivery_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        peer_device_id = excluded.peer_device_id,
        sender_device_id = excluded.sender_device_id,
        recipient_device_id = excluded.recipient_device_id,
        content = excluded.content,
        content_bytes = excluded.content_bytes,
        created_at = excluded.created_at,
        sequence = excluded.sequence,
        delivery_state = excluded.delivery_state
    `,
    message.messageId, message.peerDeviceId, message.senderDeviceId, message.recipientDeviceId,
    message.content, message.contentBytes, message.createdAt, message.sequence, message.deliveryState
  ).then(() => undefined))
  for (const observer of changeObservers) observer()
}

function toMessage(row: Row): LocalTextMessage {
  return {
    content: row.content,
    contentBytes: row.content_bytes,
    createdAt: row.created_at,
    deliveryState: row.delivery_state,
    messageId: row.message_id,
    peerDeviceId: row.peer_device_id,
    recipientDeviceId: row.recipient_device_id,
    senderDeviceId: row.sender_device_id,
    sequence: row.sequence
  }
}
