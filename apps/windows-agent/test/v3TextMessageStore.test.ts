import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {V3TextMessageStore} from '../src/transfers/v3TextMessageStore'

test('stores text messages idempotently and pages recipient messages by sequence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-text-'))
  const store = new V3TextMessageStore(root)
  try {
    const first = await store.append({
      content: 'hello',
      messageId: 'message-001',
      recipientDeviceId: 'agent-001',
      senderDeviceId: 'mobile-001'
    })
    const duplicate = await store.append({
      content: 'hello',
      messageId: 'message-001',
      recipientDeviceId: 'agent-001',
      senderDeviceId: 'mobile-001'
    })
    const second = await store.append({
      content: 'world',
      messageId: 'message-002',
      recipientDeviceId: 'mobile-001',
      senderDeviceId: 'agent-001'
    })

    assert.equal(first.sequence, duplicate.sequence)
    assert.equal(first.contentBytes, 5)
    const received = await store.listForRecipient('mobile-001', 0, 100)
    assert.deepEqual(received.messages.map((message) => message.messageId), [second.messageId])
    assert.equal(received.nextAfter, second.sequence)
    assert.deepEqual(
      (await store.listConversation('agent-001', 'mobile-001')).map((message) => message.messageId),
      [first.messageId, second.messageId]
    )
  } finally {
    await store.close()
    rmSync(root, {force: true, recursive: true})
  }
})

test('rejects a message above the UTF-8 byte ceiling', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-text-limit-'))
  const store = new V3TextMessageStore(root)
  try {
    await assert.rejects(
      store.append({
        content: '中'.repeat(501),
        messageId: 'message-limit',
        recipientDeviceId: 'agent-001',
        senderDeviceId: 'mobile-001'
      }),
      (error: unknown) => hasTransportCode(error, 'INVALID_TEXT_MESSAGE', 400)
    )
  } finally {
    await store.close()
    rmSync(root, {force: true, recursive: true})
  }
})

function hasTransportCode(value: unknown, code: string, statusCode: number) {
  return value !== null
    && typeof value === 'object'
    && (value as {code?: unknown}).code === code
    && (value as {statusCode?: unknown}).statusCode === statusCode
}
