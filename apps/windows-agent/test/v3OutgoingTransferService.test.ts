import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {V3OutgoingTransferService} from '../src/transfers/v3OutgoingTransferService'

const CHUNK_SIZE = 1024 * 1024
const RECIPIENT = 'mobile-001'

test('serves immutable chunks only to the persisted recipient and completes after durable acknowledgements', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-outgoing-'))
  const sourcePath = path.join(root, 'source.bin')
  const source = Buffer.concat([Buffer.alloc(CHUNK_SIZE, 0x61), Buffer.from('tail')])
  writeFileSync(sourcePath, source)
  const service = new V3OutgoingTransferService(path.join(root, 'outgoing'))

  try {
    const offer = await service.create({
      chunkSizeBytes: CHUNK_SIZE,
      items: [{
        itemId: 'item-001',
        mimeType: 'application/octet-stream',
        name: 'source.bin',
        sourcePath
      }],
      recipientDeviceId: RECIPIENT,
      transferId: 'transfer-001'
    })
    assert.equal(offer.revision, 1)
    assert.equal(offer.items[0]?.sizeBytes, source.length)
    assert.deepEqual(await service.getOffers(RECIPIENT), [offer])

    await assert.rejects(
      service.getStatus(offer.transferId, 'other-device'),
      (error: unknown) => (error as {code?: string}).code === 'TRANSFER_FORBIDDEN'
    )

    const delivered = await service.markOfferDelivered(offer.transferId, RECIPIENT)
    assert.equal(delivered.revision, 2)
    const first = await service.readChunk(offer.transferId, 'item-001', 0, RECIPIENT)
    assert.deepEqual(first.data, source.subarray(0, CHUNK_SIZE))
    assert.equal(first.start, 0)
    assert.equal(first.end, CHUNK_SIZE - 1)
    assert.equal(first.total, source.length)

    const firstAcknowledged = await service.acknowledgeChunk(
      offer.transferId,
      'item-001',
      0,
      RECIPIENT,
      first.sha256,
      first.data.length
    )
    assert.equal(firstAcknowledged.status, 'transferring')
    assert.deepEqual(firstAcknowledged.acknowledgedRanges, {'item-001': [[0, CHUNK_SIZE - 1]]})

    const second = await service.readChunk(offer.transferId, 'item-001', 1, RECIPIENT)
    const completed = await service.acknowledgeChunk(
      offer.transferId,
      'item-001',
      1,
      RECIPIENT,
      second.sha256,
      second.data.length
    )
    assert.equal(second.sha256, createHash('sha256').update(source.subarray(CHUNK_SIZE)).digest('hex'))
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.acknowledgedRanges, {'item-001': [[0, CHUNK_SIZE - 1], [CHUNK_SIZE, source.length - 1]]})

    const restarted = new V3OutgoingTransferService(path.join(root, 'outgoing'))
    const recovered = await restarted.getStatus(offer.transferId, RECIPIENT)
    assert.equal(recovered.status, 'completed')
    assert.equal(recovered.revision, completed.revision)
  } finally {
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})
