import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {mkdir, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'

import {calculateV3ContentRootFromHexDigests} from '../src/transfers/v3ContentRoot'
import {V3TransferStore} from '../src/transfers/v3TransferStore'
import {
  V3TransferCompletionRetryableError,
  V3_TRANSFER_BATCH_SIZE,
  V3_TRANSFER_BATCH_WINDOW_MS,
  V3TransferWriter
} from '../src/transfers/v3TransferWriter'

const CHUNK_BYTES = 1024 * 1024
const SOURCE_DEVICE_ID = 'device-001'

test('commits up to four chunks in one durable worker revision and keeps duplicate ACKs idempotent', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-'))
  const transferId = 'transfer-batch-001'
  const itemId = 'item-batch-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const committed: Array<{revision: number; transferId: string}> = []
  const writer = new V3TransferWriter(store, {onCommitted: (change) => committed.push(change)})

  try {
    assert.equal(V3_TRANSFER_BATCH_SIZE, 4)
    assert.equal(V3_TRANSFER_BATCH_WINDOW_MS, 20)
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'batch.bin',
        sizeBytes: CHUNK_BYTES * 4
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    const chunks = [0, 1, 2, 3].map((chunkIndex) => createQueuedChunk(transferId, itemId, chunkIndex))
    const acknowledgements = await Promise.all(chunks.map((chunk) => writer.enqueue(chunk)))

    for (const [chunkIndex, acknowledgement] of acknowledgements.entries()) {
      assert.deepEqual(acknowledgement, {
        chunkIndex,
        itemId,
        receivedBytes: CHUNK_BYTES * 4,
        revision: 1,
        transferReceivedBytes: CHUNK_BYTES * 4
      })
    }
    assert.deepEqual(committed, [{revision: 1, transferId}])
    assert.deepEqual(
      readFileSync(path.join(root, 'transfers', 'staging-v3', transferId, `${itemId}.part`)),
      Buffer.concat(chunks.map((chunk) => chunk.data))
    )

    const retry = await writer.enqueue(chunks[0])
    assert.deepEqual(retry, acknowledgements[0])
    assert.deepEqual(committed, [{revision: 1, transferId}])
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('holds a sub-batch until its configured batch window expires', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-window-'))
  const transferId = 'transfer-window-001'
  const itemId = 'item-window-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const writer = new V3TransferWriter(store, {batchWindowMs: 40})

  try {
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'window.bin',
        sizeBytes: CHUNK_BYTES
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    let settled = false
    const acknowledgement = writer.enqueue(createQueuedChunk(transferId, itemId, 0)).then((value) => {
      settled = true
      return value
    })
    await delay(10)
    assert.equal(settled, false)
    assert.equal((await acknowledgement).revision, 1)
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('keeps a paused sub-batch in memory until resume, then acknowledges its original request', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-paused-'))
  const transferId = 'transfer-paused-001'
  const itemId = 'item-paused-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const writer = new V3TransferWriter(store, {batchWindowMs: 80})
  const stagingPath = path.join(root, 'transfers', 'staging-v3', transferId, `${itemId}.part`)

  try {
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'paused.bin',
        sizeBytes: CHUNK_BYTES
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    let settled = false
    const acknowledgement = writer.enqueue(createQueuedChunk(transferId, itemId, 0)).then((value) => {
      settled = true
      return value
    })
    const paused = await writer.pause(
      transferId,
      SOURCE_DEVICE_ID,
      () => store.pauseTransfer(transferId, SOURCE_DEVICE_ID)
    )

    assert.deepEqual(paused, {revision: 1, status: 'paused'})
    await delay(120)
    assert.equal(settled, false)
    assert.equal(existsSync(stagingPath), false)
    assert.equal((await store.getStatus(transferId, SOURCE_DEVICE_ID)).transferReceivedBytes, 0)
    await assert.rejects(
      writer.enqueue(createQueuedChunk(transferId, itemId, 0)),
      (error: unknown) => (error as {code?: string}).code === 'TRANSFER_PAUSED'
    )

    const resumed = await writer.resume(
      transferId,
      SOURCE_DEVICE_ID,
      () => store.resumeTransfer(transferId, SOURCE_DEVICE_ID)
    )
    assert.deepEqual(resumed, {revision: 2, status: 'transferring'})
    assert.deepEqual(await acknowledgement, {
      chunkIndex: 0,
      itemId,
      receivedBytes: CHUNK_BYTES,
      revision: 3,
      transferReceivedBytes: CHUNK_BYTES
    })
    assert.equal((await store.getStatus(transferId, SOURCE_DEVICE_ID)).transferReceivedBytes, CHUNK_BYTES)
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('cancelling rejects non-durable chunks without allowing them to become durable', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-cancelled-'))
  const transferId = 'transfer-cancelled-001'
  const itemId = 'item-cancelled-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const writer = new V3TransferWriter(store, {batchWindowMs: 200})
  const stagingPath = path.join(root, 'transfers', 'staging-v3', transferId, `${itemId}.part`)

  try {
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'cancelled.bin',
        sizeBytes: CHUNK_BYTES * 5
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    const durableChunks = [0, 1, 2, 3].map((chunkIndex) => createQueuedChunk(transferId, itemId, chunkIndex))
    await Promise.all(durableChunks.map((chunk) => writer.enqueue(chunk)))
    assert.equal(existsSync(stagingPath), true)

    const pendingAcknowledgement = writer.enqueue(createQueuedChunk(transferId, itemId, 4))
    const pendingOutcome = pendingAcknowledgement.then(
      () => ({kind: 'acknowledged'} as const),
      (error: unknown) => ({error, kind: 'rejected'} as const)
    )
    const cancelled = await writer.cancel(
      transferId,
      SOURCE_DEVICE_ID,
      () => store.cancelTransfer(transferId, SOURCE_DEVICE_ID)
    )

    assert.deepEqual(cancelled, {revision: 2, status: 'cancelled'})
    const pending = await pendingOutcome
    assert.equal(pending.kind, 'rejected')
    if (pending.kind === 'rejected') {
      assert.equal((pending.error as {code?: string}).code, 'TRANSFER_CLOSING')
    }
    assert.equal(readFileSync(stagingPath).length, CHUNK_BYTES * 4)
    const status = await store.getStatus(transferId, SOURCE_DEVICE_ID)
    assert.equal(status.status, 'cancelled')
    assert.equal(status.transferReceivedBytes, CHUNK_BYTES * 4)
    assert.equal((await store.getChunkDigests(transferId, itemId, SOURCE_DEVICE_ID, 0, 1000)).total, 4)
    assert.equal((await store.getChunkAck(transferId, itemId, 0)).chunkIndex, 0)
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('overwrites an unregistered staging chunk instead of treating its file length as durable', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-orphan-'))
  const transferId = 'transfer-orphan-001'
  const itemId = 'item-orphan-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const writer = new V3TransferWriter(store)

  try {
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'orphan.bin',
        sizeBytes: CHUNK_BYTES
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })
    const orphanDirectory = path.join(root, 'transfers', 'staging-v3', transferId)
    const stagingPath = path.join(orphanDirectory, `${itemId}.part`)
    await mkdir(orphanDirectory, {recursive: true})
    await writeFile(stagingPath, Buffer.alloc(CHUNK_BYTES, 0xff))

    const chunk = createQueuedChunk(transferId, itemId, 0)
    const acknowledgement = await writer.enqueue(chunk)
    assert.equal(acknowledgement.revision, 1)
    assert.deepEqual(readFileSync(stagingPath), chunk.data)
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('bounds coalesced retry waiters instead of recursively chaining them', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-retry-'))
  const transferId = 'transfer-retry-001'
  const itemId = 'item-retry-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const writer = new V3TransferWriter(store, {
    batchWindowMs: 40,
    maxQueuedChunkRequests: 3,
    maxQueuedChunkRequestsPerTransfer: 3
  })

  try {
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'retry.bin',
        sizeBytes: CHUNK_BYTES
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    const chunk = createQueuedChunk(transferId, itemId, 0)
    const results = await Promise.allSettled(Array.from({length: 5}, () => writer.enqueue(chunk)))
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3)
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    assert.equal(failures.length, 2)
    for (const failure of failures) {
      assert.equal((failure.reason as {code?: string}).code, 'TRANSFER_BACKPRESSURE')
    }
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('serializes completion behind accepted chunks and rejects chunks after its barrier', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-completing-'))
  const transferId = 'transfer-completing-001'
  const itemId = 'item-completing-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const writer = new V3TransferWriter(store, {batchWindowMs: 100})

  try {
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'completing.bin',
        sizeBytes: CHUNK_BYTES
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    let completionStarted = false
    const chunk = createQueuedChunk(transferId, itemId, 0)
    const firstAcknowledgement = writer.enqueue(chunk)
    const completion = writer.runCompletion(transferId, SOURCE_DEVICE_ID, async () => {
      const durableAcknowledgement = await store.getChunkAck(transferId, itemId, 0)
      completionStarted = true
      assert.equal(durableAcknowledgement.revision, 1)
      const contentRoot = calculateV3ContentRootFromHexDigests({
        chunkSizeBytes: CHUNK_BYTES,
        chunks: [{index: 0, length: CHUNK_BYTES, sha256: chunk.sha256}],
        fileSizeBytes: CHUNK_BYTES
      })
      const completionResult = await store.beginCompletion(transferId, SOURCE_DEVICE_ID, [{contentRoot, itemId}])
      assert.equal(completionResult.snapshot.status, 'completing')
      return 'completed'
    })

    await assert.rejects(
      writer.enqueue(chunk),
      (error: unknown) => (error as {code?: string}).code === 'TRANSFER_CLOSING'
    )
    assert.equal(completionStarted, false)
    assert.equal((await firstAcknowledgement).revision, 1)
    assert.equal(await completion, 'completed')

    const writerState = writer as unknown as {
      queues: Map<string, unknown>
    }
    assert.equal(writerState.queues.has(transferId), false)

    await assert.rejects(
      writer.enqueue(chunk),
      (error: unknown) => (error as {code?: string}).code === 'TRANSFER_CLOSING'
    )
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('reopens an idle transfer only for an explicitly retryable completion failure', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-completing-idle-'))
  const transferId = 'transfer-completing-idle-001'
  const itemId = 'item-completing-idle-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const writer = new V3TransferWriter(store)

  try {
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'completing-idle.bin',
        sizeBytes: CHUNK_BYTES * 2
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })
    await writer.enqueue(createQueuedChunk(transferId, itemId, 0))
    await delay(0)

    await assert.rejects(
      writer.runCompletion(transferId, SOURCE_DEVICE_ID, async () => {
        throw new V3TransferCompletionRetryableError(new Error('transfer incomplete'))
      }),
      /transfer incomplete/
    )
    assert.equal((await writer.enqueue(createQueuedChunk(transferId, itemId, 1))).revision, 2)

    await assert.rejects(
      writer.runCompletion(transferId, SOURCE_DEVICE_ID, async () => {
        throw new Error('verification failed')
      }),
      /verification failed/
    )
    assert.equal((await writer.enqueue(createQueuedChunk(transferId, itemId, 0))).revision, 2)
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('waits for a failed completion callback without failing writer shutdown', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-writer-completing-close-'))
  const transferId = 'transfer-completing-close-001'
  const itemId = 'item-completing-close-001'
  const store = new V3TransferStore(path.join(root, 'transfers'))
  const writer = new V3TransferWriter(store)

  try {
    await store.createOrGet({
      chunkSizeBytes: CHUNK_BYTES,
      items: [{
        itemId,
        mimeType: 'application/octet-stream',
        name: 'completing-close.bin',
        sizeBytes: CHUNK_BYTES
      }],
      sourceDeviceId: SOURCE_DEVICE_ID,
      transferId
    })

    const completion = writer.runCompletion(transferId, SOURCE_DEVICE_ID, async () => {
      throw new Error('verification failed during shutdown')
    })
    const closing = writer.close()
    await assert.rejects(completion, /verification failed during shutdown/)
    await assert.doesNotReject(closing)
  } finally {
    await writer.close()
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('fails new storage requests and shutdown promptly after a worker exit', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-worker-exit-'))
  const store = new V3TransferStore(path.join(root, 'transfers'))
  try {
    await store.listForAdmin()
    const worker = (store as unknown as {worker: {terminate: () => Promise<number>}}).worker
    await worker.terminate()

    await assert.rejects(store.listForAdmin(), /worker stopped/)
    await Promise.race([
      store.close(),
      delay(500).then(() => {
        throw new Error('V3 transfer store shutdown hung after a worker exit.')
      })
    ])
  } finally {
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('does not hang close when the worker exits during the close handshake', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-worker-close-exit-'))
  const store = new V3TransferStore(path.join(root, 'transfers'))
  try {
    await store.listForAdmin()
    const worker = (store as unknown as {worker: {terminate: () => Promise<number>}}).worker
    const closing = store.close()
    await worker.terminate()
    await Promise.race([
      closing,
      delay(500).then(() => {
        throw new Error('V3 transfer store close hung after a worker exit during shutdown.')
      })
    ])
  } finally {
    await store.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

function createQueuedChunk(transferId: string, itemId: string, chunkIndex: number) {
  const data = Buffer.alloc(CHUNK_BYTES, chunkIndex)
  return {
    chunkIndex,
    data,
    itemId,
    offset: chunkIndex * CHUNK_BYTES,
    sha256: createHash('sha256').update(data).digest('hex'),
    sourceDeviceId: SOURCE_DEVICE_ID,
    transferId
  }
}
