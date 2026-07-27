import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync, rmSync} from 'node:fs'
import {mkdir, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  calculateV3ContentRoot,
  calculateV3ContentRootFromHexDigests,
  decodeV3ContentRootHex,
  getV3ContentRootChunkCount,
  getV3ContentRootChunkLength,
  isV3ContentRootHex
} from '../src/transfers/v3ContentRoot'
import {V3ContentVerifier} from '../src/transfers/v3ContentVerifier'
import type {V3ContentVerificationProgress} from '../src/transfers/v3ContentVerificationWorker'

test('calculates the specified zero-byte and multi-chunk V3 content roots', () => {
  assert.equal(getV3ContentRootChunkCount(0, 1024 * 1024), 0)
  assert.equal(
    calculateV3ContentRoot({chunkSizeBytes: 1024 * 1024, chunks: [], fileSizeBytes: 0}),
    '3904664ae64537a1ea22c9c6d304693523dc9bfd85ecc39f686b014e3f97b416'
  )

  const chunks = [Buffer.from('abc'), Buffer.from('def'), Buffer.from('gh')]
  assert.deepEqual(chunks.map((chunk, index) => getV3ContentRootChunkLength(8, 3, index)), [3, 3, 2])
  const root = calculateV3ContentRoot({
    chunkSizeBytes: 3,
    chunks: chunks.map((chunk, index) => ({
      index,
      length: chunk.length,
      sha256: createHash('sha256').update(chunk).digest()
    })),
    fileSizeBytes: 8
  })
  assert.equal(root, 'f9c4343bbea3606bd83f8055a5c74378dca89afa16145b86edac869337932873')
})

test('accepts only lowercase wire digests and validates the durable chunk sequence', () => {
  const digest = createHash('sha256').update('abc').digest('hex')
  assert.equal(isV3ContentRootHex(digest), true)
  assert.equal(isV3ContentRootHex(digest.toUpperCase()), false)
  assert.throws(() => decodeV3ContentRootHex(digest.toUpperCase()), /lowercase/)
  assert.equal(
    calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: 3,
      chunks: [{index: 0, length: 3, sha256: digest}],
      fileSizeBytes: 3
    }),
    'ca62f90a40bb4efbef12569a5eff75cef5203a58a1934b0f6d7997a174ed262e'
  )
  assert.throws(() => calculateV3ContentRoot({
    chunkSizeBytes: 3,
    chunks: [{index: 1, length: 3, sha256: Buffer.alloc(32)}],
    fileSizeBytes: 3
  }), /ascending contiguous/)
})

test('verifies staged data in a worker and reports item-local read failures', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-content-root-'))
  const stagingDirectory = path.join(root, 'staging-v3')
  const transferId = 'transfer-verify-001'
  const itemId = 'item-verify-001'
  const data = Buffer.from('abcdefgh')
  const progress: V3ContentVerificationProgress[] = []

  try {
    await mkdir(path.join(stagingDirectory, transferId), {recursive: true})
    await writeFile(path.join(stagingDirectory, transferId, `${itemId}.part`), data)

    const verifier = new V3ContentVerifier()
    const result = await verifier.verify({
      chunkSizeBytes: 3,
      expectedItems: [
        {itemId, sizeBytes: data.length},
        {itemId: 'item-empty-001', sizeBytes: 0},
        {itemId: 'item-missing-001', sizeBytes: 3}
      ],
      stagingDirectory,
      transferId
    }, (event) => progress.push(event))

    assert.deepEqual(result.items, [
      {
        actualContentRoot: 'f9c4343bbea3606bd83f8055a5c74378dca89afa16145b86edac869337932873',
        itemId
      },
      {
        actualContentRoot: '849e5379a35b16f7fee71dae2ab189515e0666ccf063b6e3f8f256a94759d10d',
        itemId: 'item-empty-001'
      },
      {
        error: {code: 'PART_READ_ERROR', message: 'Unable to read staged V3 transfer content.'},
        itemId: 'item-missing-001'
      }
    ])
    assert.deepEqual(progress.map((event) => event.verifyingPhase), ['reading', 'hashing', 'done'])
    assert.equal(progress[0].verifyingBytes, 0)
    assert.equal(progress[2].verifyingBytes, data.length)
    assert.equal(progress[2].verifyingTotalBytes, data.length + 3)
  } finally {
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('accepts an absent zero-byte part and rejects stale or length-mismatched parts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-content-boundary-'))
  const stagingDirectory = path.join(root, 'staging-v3')
  const transferId = 'transfer-verify-boundary-001'

  try {
    await mkdir(path.join(stagingDirectory, transferId), {recursive: true})
    await writeFile(path.join(stagingDirectory, transferId, 'item-zero-stale.part'), Buffer.from('x'))
    await writeFile(path.join(stagingDirectory, transferId, 'item-length-mismatch.part'), Buffer.from('abc'))

    const result = await new V3ContentVerifier().verify({
      chunkSizeBytes: 3,
      expectedItems: [
        {itemId: 'item-zero-absent', sizeBytes: 0},
        {itemId: 'item-zero-stale', sizeBytes: 0},
        {itemId: 'item-length-mismatch', sizeBytes: 4}
      ],
      stagingDirectory,
      transferId
    })

    assert.deepEqual(result.items, [
      {
        actualContentRoot: calculateV3ContentRoot({
          chunkSizeBytes: 3,
          chunks: [],
          fileSizeBytes: 0
        }),
        itemId: 'item-zero-absent'
      },
      {
        error: {
          code: 'PART_CONTENT_ROOT_MISMATCH',
          message: 'Staged V3 transfer content does not match its durable boundary.'
        },
        itemId: 'item-zero-stale'
      },
      {
        error: {
          code: 'PART_CONTENT_ROOT_MISMATCH',
          message: 'Staged V3 transfer content does not match its durable boundary.'
        },
        itemId: 'item-length-mismatch'
      }
    ])
  } finally {
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('does not mislabel a worker-level verification failure as a part read error', async () => {
  await assert.rejects(
    new V3ContentVerifier().verify({
      chunkSizeBytes: 0,
      expectedItems: [],
      stagingDirectory: os.tmpdir(),
      transferId: 'transfer-verify-invalid-001'
    }),
    /chunk size/
  )
})
