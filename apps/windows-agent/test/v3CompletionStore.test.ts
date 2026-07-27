import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {calculateV3ContentRootFromHexDigests} from '../src/transfers/v3ContentRoot'
import {V3TransferStore} from '../src/transfers/v3TransferStore'

const CHUNK_BYTES = 1024 * 1024
const SOURCE_DEVICE_ID = 'device-completion-001'

test('persists ordered completion roots, verification progress, and digest pages', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-completion-'))
  const transferId = 'transfer-completion-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  try {
    const data = Buffer.alloc(CHUNK_BYTES, 0x5a)
    const digest = createHash('sha256').update(data).digest('hex')
    const emptyRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: CHUNK_BYTES,
      chunks: [],
      fileSizeBytes: 0
    })
    const fileRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: CHUNK_BYTES,
      chunks: [{index: 0, length: CHUNK_BYTES, sha256: digest}],
      fileSizeBytes: CHUNK_BYTES
    })
    const files = [
      {contentRoot: emptyRoot, itemId: 'item-zero'},
      {contentRoot: fileRoot, itemId: 'item-data'}
    ]

    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [
        {itemId: 'item-zero', mimeType: 'application/octet-stream', name: 'zero.bin', sizeBytes: 0},
        {itemId: 'item-data', mimeType: 'application/octet-stream', name: 'data.bin', sizeBytes: CHUNK_BYTES}
      ],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })
    await store.commitChunkBatch(transferId, SOURCE_DEVICE_ID, [{
      chunkIndex: 0,
      itemId: 'item-data',
      jobId: 1,
      sha256: digest,
      sizeBytes: CHUNK_BYTES
    }], [{
      chunkIndex: 0,
      itemId: 'item-data',
      jobId: 1,
      sha256: digest,
      sizeBytes: CHUNK_BYTES
    }])

    const page = await store.getChunkDigests(transferId, 'item-data', SOURCE_DEVICE_ID, 0, 1000)
    assert.deepEqual(page, {digests: [{index: 0, length: CHUNK_BYTES, sha256: digest}], total: 1})
    assert.deepEqual(
      await store.getChunkDigests(transferId, 'item-zero', SOURCE_DEVICE_ID, 0, 1000),
      {digests: [], total: 0}
    )

    await assert.rejects(
      store.beginCompletion(transferId, SOURCE_DEVICE_ID, [...files].reverse()),
      (error: unknown) => (error as {code?: string}).code === 'INVALID_COMPLETION_FILES'
    )

    const accepted = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, files)
    assert.equal(accepted.disposition, 'accepted')
    assert.equal(accepted.snapshot.status, 'completing')
    assert.equal(accepted.snapshot.verifyingPhase, 'idle')
    assert.equal(accepted.snapshot.verifyingTotalBytes, CHUNK_BYTES)
    assert.ok(accepted.verificationPlan)

    const replay = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, files)
    assert.equal(replay.disposition, 'already-completing')
    assert.equal(replay.snapshot.revision, accepted.snapshot.revision)

    const progress = await store.setVerificationProgress(
      transferId,
      accepted.completionAttempt,
      CHUNK_BYTES,
      CHUNK_BYTES,
      'hashing'
    )
    assert.equal(progress.applied, true)
    assert.equal(progress.snapshot.verifyingPhase, 'hashing')
    assert.ok(progress.snapshot.revision > accepted.snapshot.revision)

    const incorrectRoot = `${fileRoot.slice(0, -1)}${fileRoot.endsWith('0') ? '1' : '0'}`
    const failed = await store.markTransferCompleted(transferId, accepted.completionAttempt, [
      {contentRoot: emptyRoot, itemId: 'item-zero'},
      {contentRoot: incorrectRoot, itemId: 'item-data'}
    ])
    assert.equal(failed.applied, true)
    assert.equal(failed.snapshot.status, 'failed')
    assert.equal(failed.snapshot.errorCode, 'PART_CONTENT_ROOT_MISMATCH')
  } finally {
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('permits the same completion request to retry only after PART_READ_ERROR', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-completion-retry-'))
  const transferId = 'transfer-completion-retry-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  try {
    const emptyRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: CHUNK_BYTES,
      chunks: [],
      fileSizeBytes: 0
    })
    const files = [{contentRoot: emptyRoot, itemId: 'item-zero'}]
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{itemId: 'item-zero', mimeType: 'application/octet-stream', name: 'zero.bin', sizeBytes: 0}],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    const accepted = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, files)
    const readFailure = await store.markTransferFailed(
      transferId,
      accepted.completionAttempt,
      'PART_READ_ERROR',
      0,
      0,
      'reading'
    )
    assert.equal(readFailure.snapshot.status, 'failed')
    assert.equal(readFailure.snapshot.errorCode, 'PART_READ_ERROR')

    const retried = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, files)
    assert.equal(retried.disposition, 'retrying')
    assert.equal(retried.snapshot.status, 'completing')
    assert.ok(retried.completionAttempt > accepted.completionAttempt)
  } finally {
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('keeps verification bytes monotonic across a retryable part read failure', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-completion-progress-retry-'))
  const transferId = 'transfer-completion-progress-retry-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  try {
    const data = Buffer.alloc(CHUNK_BYTES, 0x6b)
    const digest = createHash('sha256').update(data).digest('hex')
    const contentRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: CHUNK_BYTES,
      chunks: [{index: 0, length: CHUNK_BYTES, sha256: digest}],
      fileSizeBytes: CHUNK_BYTES
    })
    const files = [{contentRoot, itemId: 'item-data'}]
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{itemId: 'item-data', mimeType: 'application/octet-stream', name: 'data.bin', sizeBytes: CHUNK_BYTES}],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })
    await store.commitChunkBatch(transferId, SOURCE_DEVICE_ID, [{
      chunkIndex: 0,
      itemId: 'item-data',
      jobId: 1,
      sha256: digest,
      sizeBytes: CHUNK_BYTES
    }], [{
      chunkIndex: 0,
      itemId: 'item-data',
      jobId: 1,
      sha256: digest,
      sizeBytes: CHUNK_BYTES
    }])

    const accepted = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, files)
    const half = CHUNK_BYTES / 2
    const reading = await store.setVerificationProgress(
      transferId,
      accepted.completionAttempt,
      half,
      CHUNK_BYTES,
      'reading'
    )
    const readFailure = await store.markTransferFailed(
      transferId,
      accepted.completionAttempt,
      'PART_READ_ERROR',
      half,
      CHUNK_BYTES,
      'reading'
    )
    assert.equal(readFailure.snapshot.verifyingBytes, half)

    const retried = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, files)
    assert.equal(retried.disposition, 'retrying')
    assert.equal(retried.snapshot.verifyingBytes, half)
    assert.equal(retried.snapshot.verifyingPhase, 'idle')
    assert.ok(retried.snapshot.revision > readFailure.snapshot.revision)

    const retryReading = await store.setVerificationProgress(
      transferId,
      retried.completionAttempt,
      0,
      CHUNK_BYTES,
      'reading'
    )
    assert.equal(retryReading.applied, true)
    assert.equal(retryReading.snapshot.verifyingBytes, half)
    assert.equal(retryReading.snapshot.verifyingPhase, 'reading')
    assert.ok(retryReading.snapshot.revision > retried.snapshot.revision)
    assert.ok(reading.snapshot.revision < readFailure.snapshot.revision)
  } finally {
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('persists CONTENT_ROOT_MISMATCH and refuses a different completion root', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-completion-mismatch-'))
  const transferId = 'transfer-completion-mismatch-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  try {
    const emptyRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: CHUNK_BYTES,
      chunks: [],
      fileSizeBytes: 0
    })
    const incorrectRoot = `${emptyRoot.slice(0, -1)}${emptyRoot.endsWith('0') ? '1' : '0'}`
    const files = [{contentRoot: incorrectRoot, itemId: 'item-zero'}]
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{itemId: 'item-zero', mimeType: 'application/octet-stream', name: 'zero.bin', sizeBytes: 0}],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    const mismatch = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, files)
    assert.equal(mismatch.disposition, 'failed')
    assert.equal(mismatch.snapshot.status, 'failed')
    assert.equal(mismatch.snapshot.errorCode, 'CONTENT_ROOT_MISMATCH')

    const replay = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, files)
    assert.equal(replay.disposition, 'failed')
    assert.equal(replay.snapshot.revision, mismatch.snapshot.revision)
    await assert.rejects(
      store.beginCompletion(transferId, SOURCE_DEVICE_ID, [{contentRoot: emptyRoot, itemId: 'item-zero'}]),
      (error: unknown) => (error as {code?: string}).code === 'TRANSFER_COMPLETION_CONFLICT'
    )
  } finally {
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})
