import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import Fastify, {type FastifyInstance} from 'fastify'

import {AgentEventBus} from '../src/realtime/agentEventBus'
import {TrustedDeviceStore} from '../src/storage/trustedDeviceStore'
import {canonicalizeJson} from '../src/transfers/v3CanonicalJson'
import {calculateV3ContentRootFromHexDigests} from '../src/transfers/v3ContentRoot'
import {migrateV3TransferDatabase, rollbackLatestV3TransferMigration} from '../src/transfers/v3Migration'
import {V3TransferAuthenticator, createV3RequestSignature} from '../src/transfers/v3TransferAuthenticator'
import {V3TransferService} from '../src/transfers/v3TransferService'
import {type V3ChunkMetadata, V3TransferStore} from '../src/transfers/v3TransferStore'
import {V3TrustedDeviceAccessClient} from '../src/transfers/v3TrustedDeviceAccess'
import {registerLegacyTransferGoneRoutes, v3TransportRoutes} from '../src/transfers/v3TransportRoutes'

const DEVICE_ID = 'device-001'
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

type Fixture = {
  app: FastifyInstance
  cleanup: () => Promise<void>
  eventBus: AgentEventBus
  root: string
  trustedDeviceStore: TrustedDeviceStore
}

test('uses the fixed V3 HMAC vectors over exact UTF-8 bytes', () => {
  const vectorPath = path.join(__dirname, 'fixtures', 'v3-hmac-vectors.json')
  const vectors = JSON.parse(readFileSync(vectorPath, 'utf8')) as {
    chunkDigestsQueryOrder: string[]
    cases: Array<{body: string; bodySha256: string; method: string; name: string; path: string; signature: string}>
    nonce: string
    pathSemantics: string
    secretHex: string
    timestamp: string
  }

  assert.equal(vectors.pathSemantics, 'full-request-target-including-query')
  assert.deepEqual(vectors.chunkDigestsQueryOrder, ['offset', 'limit'])

  for (const vector of vectors.cases) {
    const body = Buffer.from(vector.body, 'utf8')
    assert.equal(createHash('sha256').update(body).digest('hex'), vector.bodySha256, vector.name)
    assert.equal(createV3RequestSignature(vectors.secretHex, {
      body,
      method: vector.method,
      nonce: vectors.nonce,
      path: vector.path,
      timestamp: vectors.timestamp
    }), vector.signature, vector.name)
  }

  const digestPageVector = vectors.cases.find((vector) => vector.name === 'chunk-digests-page-request-target')
  assert.ok(digestPageVector)
  assert.equal(
    digestPageVector.path,
    '/v3/transfers/00000000-0000-4000-8000-000000000001/items/00000000-0000-4000-8000-000000000002/chunk-digests?offset=0&limit=1000'
  )
  assert.notEqual(createV3RequestSignature(vectors.secretHex, {
    body: Buffer.alloc(0),
    method: digestPageVector.method,
    nonce: vectors.nonce,
    path: digestPageVector.path.split('?')[0],
    timestamp: vectors.timestamp
  }), digestPageVector.signature)
})

test('returns 410 for every retired transfer endpoint before authentication', async () => {
  const fixture = await createFixture()
  try {
    const requests = [
      {method: 'POST', url: '/api/transfers/admission'},
      {method: 'POST', url: '/v1/transfers'},
      {method: 'GET', url: '/v1/transfers/transfer-001'},
      {method: 'PUT', url: '/v1/transfers/transfer-001/items/item-001/chunks/0'},
      {method: 'POST', url: '/v1/transfers/transfer-001/complete'},
      {method: 'POST', url: '/v1/transfers/transfer-001/cancel'},
      {method: 'POST', url: '/v1/transfers/transfer-001/pause'},
      {method: 'POST', url: '/v1/transfers/transfer-001/resume'},
      {method: 'POST', url: '/v1/transfers/transfer-001/text'},
      {method: 'POST', url: '/v2/transfers'},
      {method: 'GET', url: '/v2/transfers/transfer-001'},
      {method: 'POST', url: '/v2/transfers/transfer-001/text'}
    ] as const
    for (const request of requests) {
      const response = await fixture.app.inject(request)
      assert.equal(response.statusCode, 410, `${request.method} ${request.url}`)
      assert.deepEqual(response.json(), {code: 'TRANSFER_PROTOCOL_GONE'})
    }
  } finally {
    await fixture.cleanup()
  }
})

test('keeps V3 authentication and receive permission off synchronous trusted-device APIs', async () => {
  const fixture = await createFixture()
  try {
    fixture.trustedDeviceStore.get = () => {
      throw new Error('V3 must not call TrustedDeviceStore.get().')
    }
    fixture.trustedDeviceStore.getTransferSecret = () => {
      throw new Error('V3 must not call TrustedDeviceStore.getTransferSecret().')
    }

    const capabilityPath = '/v1/transport/capabilities'
    const enabled = await fixture.app.inject({
      headers: signedHeaders('GET', capabilityPath, Buffer.alloc(0), 'nonce-async-trusted-device-enabled'),
      method: 'GET',
      url: capabilityPath
    })
    assert.equal(enabled.statusCode, 200)

    const replayHeaders = signedHeaders('GET', capabilityPath, Buffer.alloc(0), 'nonce-async-trusted-device-replay')
    const replayResponses = await Promise.all([
      fixture.app.inject({headers: replayHeaders, method: 'GET', url: capabilityPath}),
      fixture.app.inject({headers: {...replayHeaders}, method: 'GET', url: capabilityPath})
    ])
    assert.deepEqual(replayResponses.map((response) => response.statusCode).sort(), [200, 401])

    const rotatedSecret = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    fixture.trustedDeviceStore.setTransferSecret(DEVICE_ID, rotatedSecret)
    const rotated = await fixture.app.inject({
      headers: signedHeaders('GET', capabilityPath, Buffer.alloc(0), 'nonce-async-trusted-device-rotated', rotatedSecret),
      method: 'GET',
      url: capabilityPath
    })
    assert.equal(rotated.statusCode, 200)

    fixture.trustedDeviceStore.setReceiveEnabled(DEVICE_ID, false)
    const disabled = await fixture.app.inject({
      headers: signedHeaders('GET', capabilityPath, Buffer.alloc(0), 'nonce-async-trusted-device-disabled', rotatedSecret),
      method: 'GET',
      url: capabilityPath
    })
    assert.equal(disabled.statusCode, 403)
    assert.deepEqual(disabled.json(), {code: 'TRANSFER_RECEIVE_DISABLED'})
  } finally {
    await fixture.cleanup()
  }
})

test('authenticates capabilities and creates V3 transfers from canonical raw JSON', async () => {
  const fixture = await createFixture()
  try {
    const capabilityPath = '/v1/transport/capabilities'
    const missingAuth = await fixture.app.inject({method: 'GET', url: capabilityPath})
    assert.equal(missingAuth.statusCode, 401)

    const capabilities = await fixture.app.inject({
      headers: signedHeaders('GET', capabilityPath, Buffer.alloc(0), 'nonce-capabilities'),
      method: 'GET',
      url: capabilityPath
    })
    assert.equal(capabilities.statusCode, 200)
    assert.deepEqual(capabilities.json(), {
      maxChunkBytes: 4 * 1024 * 1024,
      maxInFlightChunks: 2,
      protocols: [3]
    })

    const uppercaseSignatureHeaders = signedHeaders(
      'GET',
      capabilityPath,
      Buffer.alloc(0),
      'nonce-capabilities-uppercase'
    )
    const signatureSeparator = uppercaseSignatureHeaders.authorization.lastIndexOf(':')
    const uppercaseSignature = await fixture.app.inject({
      headers: {
        ...uppercaseSignatureHeaders,
        authorization: `${uppercaseSignatureHeaders.authorization.slice(0, signatureSeparator + 1)}${uppercaseSignatureHeaders.authorization
          .slice(signatureSeparator + 1)
          .toUpperCase()}`
      },
      method: 'GET',
      url: capabilityPath
    })
    assert.equal(uppercaseSignature.statusCode, 401)

    const request = createRequest()
    const canonicalBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const created = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', canonicalBody, 'nonce-create'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: canonicalBody,
      url: '/v3/transfers'
    })
    assert.equal(created.statusCode, 201)
    assert.deepEqual(created.json(), {
      chunkSizeBytes: 1024 * 1024,
      items: [{itemId: 'item-001', receivedBytes: 0, receivedRanges: []}],
      protocol: 3,
      revision: 0,
      status: 'negotiating',
      transferId: 'transfer-001',
      transferReceivedBytes: 0
    })

    const nonCanonicalBody = Buffer.from(JSON.stringify({
      transferId: request.transferId,
      sourceDeviceId: request.sourceDeviceId,
      items: request.items,
      chunkSizeBytes: request.chunkSizeBytes,
      protocol: request.protocol
    }), 'utf8')
    const nonCanonical = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', nonCanonicalBody, 'nonce-noncanonical'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: nonCanonicalBody,
      url: '/v3/transfers'
    })
    assert.equal(nonCanonical.statusCode, 400)
    assert.deepEqual(nonCanonical.json(), {code: 'NON_CANONICAL_JSON'})

    const rawMismatch = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', canonicalBody, 'nonce-raw-mismatch'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: Buffer.concat([canonicalBody, Buffer.from(' ')]),
      url: '/v3/transfers'
    })
    assert.equal(rawMismatch.statusCode, 401)
  } finally {
    await fixture.cleanup()
  }
})

test('returns a durable lightweight ACK with monotonic revision', async () => {
  const fixture = await createFixture()
  try {
    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const createResponse = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-create-ack'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(createResponse.statusCode, 201)

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const response = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-chunk-1'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(response.statusCode, 200)
    const ack = response.json()
    assert.deepEqual(Object.keys(ack).sort(), ['chunkIndex', 'itemId', 'receivedBytes', 'revision', 'transferReceivedBytes'].sort())
    assert.deepEqual(ack, {
      chunkIndex: 0,
      itemId: 'item-001',
      receivedBytes: 4,
      revision: 1,
      transferReceivedBytes: 4
    })

    const retry = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-chunk-retry'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(retry.statusCode, 200)
    assert.deepEqual(retry.json(), ack)
  } finally {
    await fixture.cleanup()
  }
})

test('authenticates V3 controls over exact empty bodies, preserves revisions, and cleans cancelled staging', async () => {
  const fixture = await createFixture()
  try {
    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const created = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-control-create'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(created.statusCode, 201)

    const pausePath = '/v3/transfers/transfer-001/pause'
    const noBody = Buffer.alloc(0)
    const missingAuthentication = await fixture.app.inject({method: 'POST', url: pausePath})
    assert.equal(missingAuthentication.statusCode, 401)
    assert.deepEqual(missingAuthentication.json(), {code: 'AUTHENTICATION_REQUIRED'})

    const paused = await fixture.app.inject({
      headers: signedHeaders('POST', pausePath, noBody, 'nonce-control-pause'),
      method: 'POST',
      url: pausePath
    })
    assert.equal(paused.statusCode, 200)
    assert.deepEqual(paused.json(), {revision: 1, status: 'paused'})

    const pauseReplay = await fixture.app.inject({
      headers: signedHeaders('POST', pausePath, noBody, 'nonce-control-pause-replay'),
      method: 'POST',
      url: pausePath
    })
    assert.equal(pauseReplay.statusCode, 200)
    assert.deepEqual(pauseReplay.json(), paused.json())

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const rejectedWhilePaused = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-control-paused-chunk'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(rejectedWhilePaused.statusCode, 409)
    assert.deepEqual(rejectedWhilePaused.json(), {code: 'TRANSFER_PAUSED'})

    const resumePath = '/v3/transfers/transfer-001/resume'
    const emptyJson = Buffer.from('{}', 'utf8')
    const bodySignatureMismatch = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', resumePath, noBody, 'nonce-control-resume-body-mismatch'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: emptyJson,
      url: resumePath
    })
    assert.equal(bodySignatureMismatch.statusCode, 401)
    assert.deepEqual(bodySignatureMismatch.json(), {code: 'AUTHENTICATION_REQUIRED'})

    const resumed = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', resumePath, emptyJson, 'nonce-control-resume'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: emptyJson,
      url: resumePath
    })
    assert.equal(resumed.statusCode, 200)
    assert.deepEqual(resumed.json(), {revision: 2, status: 'transferring'})

    const resumeReplay = await fixture.app.inject({
      headers: signedHeaders('POST', resumePath, noBody, 'nonce-control-resume-replay'),
      method: 'POST',
      url: resumePath
    })
    assert.equal(resumeReplay.statusCode, 200)
    assert.deepEqual(resumeReplay.json(), resumed.json())

    const uploaded = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-control-chunk'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(uploaded.statusCode, 200)
    assert.equal(uploaded.json().revision, 3)

    const cancelPath = '/v3/transfers/transfer-001/cancel'
    const cancelled = await fixture.app.inject({
      headers: signedHeaders('POST', cancelPath, noBody, 'nonce-control-cancel'),
      method: 'POST',
      url: cancelPath
    })
    assert.equal(cancelled.statusCode, 200)
    assert.deepEqual(cancelled.json(), {revision: 4, status: 'cancelled'})
    assert.equal(
      existsSync(path.join(fixture.root, 'transfers', 'staging-v3', 'transfer-001', 'item-001.part')),
      false
    )

    const statusPath = '/v3/transfers/transfer-001/status'
    const cancelledStatus = await fixture.app.inject({
      headers: signedHeaders('GET', statusPath, noBody, 'nonce-control-cancelled-status'),
      method: 'GET',
      url: statusPath
    })
    assert.equal(cancelledStatus.statusCode, 200)
    assert.equal(cancelledStatus.json().status, 'cancelled')
    assert.deepEqual(cancelledStatus.json().items, [{itemId: 'item-001', receivedRanges: [[0, 0]]}])

    const digestPath = '/v3/transfers/transfer-001/items/item-001/chunk-digests?offset=0&limit=1000'
    const digests = await fixture.app.inject({
      headers: signedHeaders('GET', digestPath, noBody, 'nonce-control-cancelled-digests'),
      method: 'GET',
      url: digestPath
    })
    assert.equal(digests.statusCode, 200)
    assert.equal(digests.json().total, 1)

    const cancelReplay = await fixture.app.inject({
      headers: signedHeaders('POST', cancelPath, noBody, 'nonce-control-cancel-replay'),
      method: 'POST',
      url: cancelPath
    })
    assert.equal(cancelReplay.statusCode, 200)
    assert.deepEqual(cancelReplay.json(), cancelled.json())

    const invalidResume = await fixture.app.inject({
      headers: signedHeaders('POST', resumePath, noBody, 'nonce-control-cancelled-resume'),
      method: 'POST',
      url: resumePath
    })
    assert.equal(invalidResume.statusCode, 409)
    assert.deepEqual(invalidResume.json(), {code: 'TRANSFER_STATE_INVALID'})

    const missingTransfer = await fixture.app.inject({
      headers: signedHeaders('POST', '/v3/transfers/missing-001/cancel', noBody, 'nonce-control-missing'),
      method: 'POST',
      url: '/v3/transfers/missing-001/cancel'
    })
    assert.equal(missingTransfer.statusCode, 404)
    assert.deepEqual(missingTransfer.json(), {code: 'TRANSFER_NOT_FOUND'})
  } finally {
    await fixture.cleanup()
  }
})

test('waits for an in-flight chunk flush before deleting cancelled staging', async () => {
  const fixture = await createFixture()
  try {
    const service = fixture.app.v3TransferService as unknown as {transferStore: V3TransferStore}
    const transferStore = service.transferStore
    const originalCommitChunkBatch = transferStore.commitChunkBatch.bind(transferStore)
    let releaseCommit!: () => void
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    let signalCommitStarted!: () => void
    const commitStarted = new Promise<void>((resolve) => {
      signalCommitStarted = resolve
    })
    let blockFirstCommit = true
    transferStore.commitChunkBatch = async (
      transferId: string,
      sourceDeviceId: string,
      newChunks: V3ChunkMetadata[],
      acknowledgementChunks: V3ChunkMetadata[]
    ) => {
      if (blockFirstCommit) {
        blockFirstCommit = false
        signalCommitStarted()
        await commitGate
      }
      return originalCommitChunkBatch(transferId, sourceDeviceId, newChunks, acknowledgementChunks)
    }

    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const created = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-cancel-flush-create'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(created.statusCode, 201)

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const upload = fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-cancel-flush-chunk'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    await commitStarted

    const cancelPath = '/v3/transfers/transfer-001/cancel'
    const cancelling = fixture.app.inject({
      headers: signedHeaders('POST', cancelPath, Buffer.alloc(0), 'nonce-cancel-flush-cancel'),
      method: 'POST',
      url: cancelPath
    })
    let cancelSettled = false
    void cancelling.then(() => {
      cancelSettled = true
    })
    await delay(20)
    assert.equal(cancelSettled, false)

    releaseCommit()
    const [uploaded, cancelled] = await Promise.all([upload, cancelling])
    assert.equal(uploaded.statusCode, 409)
    assert.deepEqual(uploaded.json(), {code: 'TRANSFER_CLOSING'})
    assert.equal(cancelled.statusCode, 200)
    assert.equal(cancelled.json().status, 'cancelled')
    assert.equal(
      existsSync(path.join(fixture.root, 'transfers', 'staging-v3', 'transfer-001', 'item-001.part')),
      false
    )

    const statusPath = '/v3/transfers/transfer-001/status'
    const status = await fixture.app.inject({
      headers: signedHeaders('GET', statusPath, Buffer.alloc(0), 'nonce-cancel-flush-status'),
      method: 'GET',
      url: statusPath
    })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().transferReceivedBytes, 0)
    assert.deepEqual(status.json().items, [{itemId: 'item-001', receivedRanges: []}])
  } finally {
    await fixture.cleanup()
  }
})

test('publishes only durable V3 transfer changes and coalesces retries by revision', async () => {
  const fixture = await createFixture()
  const changes: Array<{revision: number; transferId: string}> = []
  const unsubscribe = fixture.eventBus.subscribe((event) => {
    if (event.type !== 'transfer.changed') return
    changes.push(event.payload as {revision: number; transferId: string})
  })
  try {
    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const created = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-create-events'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(created.statusCode, 201)
    assert.deepEqual(changes, [{revision: 0, transferId: 'transfer-001'}])

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const headers = {
      'content-range': 'bytes 0-3/4',
      'content-type': 'application/octet-stream',
      'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
    }
    const uploaded = await fixture.app.inject({
      headers: {...signedHeaders('PUT', chunkPath, chunk, 'nonce-event-chunk'), ...headers},
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(uploaded.statusCode, 200)
    assert.equal(changes.length, 1)

    await delay(280)
    assert.deepEqual(changes, [
      {revision: 0, transferId: 'transfer-001'},
      {revision: 1, transferId: 'transfer-001'}
    ])

    const retry = await fixture.app.inject({
      headers: {...signedHeaders('PUT', chunkPath, chunk, 'nonce-event-retry'), ...headers},
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(retry.statusCode, 200)
    await delay(280)
    assert.equal(changes.length, 2)
  } finally {
    unsubscribe()
    await fixture.cleanup()
  }
})

test('repairs V3 status, serves signed chunk digests, and completes only after worker verification', async () => {
  const fixture = await createFixture()
  try {
    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const created = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-complete-create'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(created.statusCode, 201)

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const uploaded = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-complete-chunk'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(uploaded.statusCode, 200)

    const statusPath = '/v3/transfers/transfer-001/status'
    const status = await fixture.app.inject({
      headers: signedHeaders('GET', statusPath, Buffer.alloc(0), 'nonce-complete-status'),
      method: 'GET',
      url: statusPath
    })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(status.json(), {
      items: [{itemId: 'item-001', receivedRanges: [[0, 0]]}],
      revision: 1,
      status: 'transferring',
      transferReceivedBytes: 4,
      verifyingBytes: 0,
      verifyingPhase: 'idle',
      verifyingTotalBytes: 0
    })

    const digestPath = '/v3/transfers/transfer-001/items/item-001/chunk-digests?offset=0&limit=1000'
    const digests = await fixture.app.inject({
      headers: signedHeaders('GET', digestPath, Buffer.alloc(0), 'nonce-complete-digests'),
      method: 'GET',
      url: digestPath
    })
    assert.equal(digests.statusCode, 200)
    assert.deepEqual(digests.json(), {
      digests: [{
        index: 0,
        length: 4,
        sha256: createHash('sha256').update(chunk).digest('hex')
      }],
      total: 1
    })

    const unsignedQuerySignature = await fixture.app.inject({
      headers: signedHeaders(
        'GET',
        '/v3/transfers/transfer-001/items/item-001/chunk-digests',
        Buffer.alloc(0),
        'nonce-digest-query-not-signed'
      ),
      method: 'GET',
      url: digestPath
    })
    assert.equal(unsignedQuerySignature.statusCode, 401)
    assert.deepEqual(unsignedQuerySignature.json(), {code: 'AUTHENTICATION_REQUIRED'})

    const nonCanonicalDigestPath = '/v3/transfers/transfer-001/items/item-001/chunk-digests?limit=1000&offset=0'
    const nonCanonicalDigests = await fixture.app.inject({
      headers: signedHeaders('GET', nonCanonicalDigestPath, Buffer.alloc(0), 'nonce-digest-query-order'),
      method: 'GET',
      url: nonCanonicalDigestPath
    })
    assert.equal(nonCanonicalDigests.statusCode, 400)
    assert.deepEqual(nonCanonicalDigests.json(), {code: 'INVALID_CHUNK_DIGEST_PAGE'})

    const contentRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: request.chunkSizeBytes,
      chunks: [{
        index: 0,
        length: chunk.length,
        sha256: createHash('sha256').update(chunk).digest('hex')
      }],
      fileSizeBytes: chunk.length
    })
    const completePath = '/v3/transfers/transfer-001/complete'
    const completeBody = Buffer.from(canonicalizeJson({
      files: [{contentRoot, itemId: 'item-001'}]
    }), 'utf8')
    const completing = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, completeBody, 'nonce-complete-request'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: completeBody,
      url: completePath
    })
    assert.equal(completing.statusCode, 202)
    assert.equal(completing.json().status, 'completing')
    assert.equal(completing.json().verifyingPhase, 'idle')

    const afterBarrier = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-complete-closing'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(afterBarrier.statusCode, 409)
    assert.deepEqual(afterBarrier.json(), {code: 'TRANSFER_CLOSING'})

    const finalStatus = await waitForTransferStatus(fixture, statusPath, 'completed')
    assert.equal(finalStatus.errorCode, undefined)
    assert.equal(finalStatus.verifyingBytes, 4)
    assert.equal(finalStatus.verifyingPhase, 'done')
    assert.equal(finalStatus.verifyingTotalBytes, 4)

    const replay = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, completeBody, 'nonce-complete-replay'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: completeBody,
      url: completePath
    })
    assert.equal(replay.statusCode, 200)
    assert.equal(replay.json().status, 'completed')
    assert.equal(replay.json().revision, finalStatus.revision)
  } finally {
    await fixture.cleanup()
  }
})

test('replays the same completion request as 202 without starting verification twice', async () => {
  const fixture = await createFixture()
  type ControlledVerificationResult = {
    items: Array<{actualContentRoot: string; itemId: string}>
    requestId: number
    type: 'result'
  }
  let verificationStarts = 0
  let resolveVerification: (result: ControlledVerificationResult) => void = () => {
    throw new Error('Controlled verification was not initialized.')
  }
  const pendingVerification = new Promise<ControlledVerificationResult>((resolve) => {
    resolveVerification = resolve
  })
  const service = fixture.app.v3TransferService as unknown as {
    contentVerifier: {verify: () => Promise<ControlledVerificationResult>}
  }
  service.contentVerifier = {
    verify: () => {
      verificationStarts += 1
      return pendingVerification
    }
  }

  try {
    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const created = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-replay-completing-create'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(created.statusCode, 201)

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const uploaded = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-replay-completing-chunk'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(uploaded.statusCode, 200)

    const contentRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: request.chunkSizeBytes,
      chunks: [{
        index: 0,
        length: chunk.length,
        sha256: createHash('sha256').update(chunk).digest('hex')
      }],
      fileSizeBytes: chunk.length
    })
    const completePath = '/v3/transfers/transfer-001/complete'
    const completeBody = Buffer.from(canonicalizeJson({
      files: [{contentRoot, itemId: 'item-001'}]
    }), 'utf8')
    const first = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, completeBody, 'nonce-replay-completing-first'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: completeBody,
      url: completePath
    })
    assert.equal(first.statusCode, 202)
    assert.equal(first.json().status, 'completing')
    assert.equal(verificationStarts, 1)

    const invalidCompleteBody = Buffer.from(canonicalizeJson({
      files: [{contentRoot, itemId: 'item-other'}]
    }), 'utf8')
    const invalidReplay = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, invalidCompleteBody, 'nonce-replay-completing-invalid'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: invalidCompleteBody,
      url: completePath
    })
    assert.equal(invalidReplay.statusCode, 400)
    assert.deepEqual(invalidReplay.json(), {code: 'INVALID_COMPLETION_FILES'})
    assert.equal(verificationStarts, 1)

    const replay = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, completeBody, 'nonce-replay-completing-second'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: completeBody,
      url: completePath
    })
    assert.equal(replay.statusCode, 202)
    assert.equal(replay.json().status, 'completing')
    assert.equal(verificationStarts, 1)

    resolveVerification({
      items: [{actualContentRoot: contentRoot, itemId: 'item-001'}],
      requestId: 1,
      type: 'result'
    })
    const statusPath = '/v3/transfers/transfer-001/status'
    const completed = await waitForTransferStatus(fixture, statusPath, 'completed')
    assert.equal(completed.status, 'completed')
    assert.equal(verificationStarts, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('cancels a completing transfer, aborts verification, and rejects stale completion mutations', async () => {
  const fixture = await createFixture()
  type ControlledVerificationResult = {
    items: Array<{actualContentRoot: string; itemId: string}>
    requestId: number
    type: 'result'
  }
  let verificationAborted = false
  let verificationStarts = 0
  const service = fixture.app.v3TransferService as unknown as {
    contentVerifier: {
      verify: (
        request: unknown,
        onProgress: unknown,
        signal: AbortSignal | undefined
      ) => Promise<ControlledVerificationResult>
    }
    transferStore: V3TransferStore
  }
  service.contentVerifier = {
    verify: (_request, _onProgress, signal) => {
      verificationStarts += 1
      return new Promise<ControlledVerificationResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          verificationAborted = true
          reject(new Error('verification cancelled'))
        }, {once: true})
      })
    }
  }

  try {
    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const created = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-cancelling-create'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(created.statusCode, 201)

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const uploaded = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-cancelling-chunk'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(uploaded.statusCode, 200)

    const contentRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: request.chunkSizeBytes,
      chunks: [{
        index: 0,
        length: chunk.length,
        sha256: createHash('sha256').update(chunk).digest('hex')
      }],
      fileSizeBytes: chunk.length
    })
    const completePath = '/v3/transfers/transfer-001/complete'
    const completeBody = Buffer.from(canonicalizeJson({
      files: [{contentRoot, itemId: 'item-001'}]
    }), 'utf8')
    const completing = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, completeBody, 'nonce-cancelling-complete'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: completeBody,
      url: completePath
    })
    assert.equal(completing.statusCode, 202)
    assert.equal(completing.json().status, 'completing')
    assert.equal(verificationStarts, 1)

    for (const operation of ['pause', 'resume'] as const) {
      const controlPath = `/v3/transfers/transfer-001/${operation}`
      const invalid = await fixture.app.inject({
        headers: signedHeaders('POST', controlPath, Buffer.alloc(0), `nonce-cancelling-${operation}`),
        method: 'POST',
        url: controlPath
      })
      assert.equal(invalid.statusCode, 409)
      assert.deepEqual(invalid.json(), {code: 'TRANSFER_STATE_INVALID'})
    }

    const cancelPath = '/v3/transfers/transfer-001/cancel'
    const cancelled = await fixture.app.inject({
      headers: signedHeaders('POST', cancelPath, Buffer.alloc(0), 'nonce-cancelling-cancel'),
      method: 'POST',
      url: cancelPath
    })
    assert.equal(cancelled.statusCode, 200)
    assert.deepEqual(cancelled.json(), {revision: 3, status: 'cancelled'})
    assert.equal(verificationAborted, true)
    assert.equal(
      existsSync(path.join(fixture.root, 'transfers', 'staging-v3', 'transfer-001', 'item-001.part')),
      false
    )

    const staleCompletion = await service.transferStore.markTransferCompleted(
      'transfer-001',
      1,
      [{contentRoot, itemId: 'item-001'}]
    )
    assert.equal(staleCompletion.applied, false)
    assert.equal(staleCompletion.snapshot.status, 'cancelled')

    const statusPath = '/v3/transfers/transfer-001/status'
    const status = await fixture.app.inject({
      headers: signedHeaders('GET', statusPath, Buffer.alloc(0), 'nonce-cancelling-status'),
      method: 'GET',
      url: statusPath
    })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().status, 'cancelled')
  } finally {
    await fixture.cleanup()
  }
})

test('does not persist a worker-level verifier failure as PART_READ_ERROR', async () => {
  const fixture = await createFixture()
  let verificationStarts = 0
  try {
    const service = fixture.app.v3TransferService as unknown as {
      contentVerifier: {
        verify: () => Promise<{
          items: Array<{actualContentRoot: string; itemId: string}>
          requestId: number
          type: 'result'
        }>
      }
    }
    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const created = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-verifier-failure-create'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(created.statusCode, 201)

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const uploaded = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-verifier-failure-chunk'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(uploaded.statusCode, 200)

    const contentRoot = calculateV3ContentRootFromHexDigests({
      chunkSizeBytes: request.chunkSizeBytes,
      chunks: [{
        index: 0,
        length: chunk.length,
        sha256: createHash('sha256').update(chunk).digest('hex')
      }],
      fileSizeBytes: chunk.length
    })
    service.contentVerifier = {
      verify: () => {
        verificationStarts += 1
        if (verificationStarts === 1) return Promise.reject(new Error('verification worker unavailable'))
        return Promise.resolve({
          items: [{actualContentRoot: contentRoot, itemId: 'item-001'}],
          requestId: 1,
          type: 'result'
        })
      }
    }

    const completePath = '/v3/transfers/transfer-001/complete'
    const completeBody = Buffer.from(canonicalizeJson({
      files: [{contentRoot, itemId: 'item-001'}]
    }), 'utf8')
    const first = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, completeBody, 'nonce-verifier-failure-first'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: completeBody,
      url: completePath
    })
    assert.equal(first.statusCode, 202)
    await delay(0)

    const statusPath = '/v3/transfers/transfer-001/status'
    const stillCompleting = await fixture.app.inject({
      headers: signedHeaders('GET', statusPath, Buffer.alloc(0), 'nonce-verifier-failure-status'),
      method: 'GET',
      url: statusPath
    })
    assert.equal(stillCompleting.statusCode, 200)
    assert.equal(stillCompleting.json().status, 'completing')
    assert.equal(stillCompleting.json().errorCode, undefined)

    const retried = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, completeBody, 'nonce-verifier-failure-retry'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: completeBody,
      url: completePath
    })
    assert.equal(retried.statusCode, 202)
    const completed = await waitForTransferStatus(fixture, statusPath, 'completed')
    assert.equal(completed.status, 'completed')
    assert.equal(verificationStarts, 2)
  } finally {
    await fixture.cleanup()
  }
})

test('persists a durable root mismatch as failed without reopening uploads', async () => {
  const fixture = await createFixture()
  try {
    const request = createRequest()
    const createBody = Buffer.from(canonicalizeJson(request), 'utf8')
    const createResponse = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', '/v3/transfers', createBody, 'nonce-mismatch-create'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: createBody,
      url: '/v3/transfers'
    })
    assert.equal(createResponse.statusCode, 201)

    const chunk = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const chunkPath = '/v3/transfers/transfer-001/items/item-001/chunks/0'
    const uploaded = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-mismatch-chunk'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(uploaded.statusCode, 200)

    const completePath = '/v3/transfers/transfer-001/complete'
    const invalidRoot = '0'.repeat(64)
    const completeBody = Buffer.from(canonicalizeJson({
      files: [{contentRoot: invalidRoot, itemId: 'item-001'}]
    }), 'utf8')
    const complete = await fixture.app.inject({
      headers: {
        ...signedHeaders('POST', completePath, completeBody, 'nonce-mismatch-complete'),
        'content-type': 'application/json'
      },
      method: 'POST',
      payload: completeBody,
      url: completePath
    })
    assert.equal(complete.statusCode, 422)
    assert.deepEqual(complete.json(), {code: 'CONTENT_ROOT_MISMATCH'})

    const statusPath = '/v3/transfers/transfer-001/status'
    const failed = await fixture.app.inject({
      headers: signedHeaders('GET', statusPath, Buffer.alloc(0), 'nonce-mismatch-status'),
      method: 'GET',
      url: statusPath
    })
    assert.equal(failed.statusCode, 200)
    assert.equal(failed.json().status, 'failed')
    assert.equal(failed.json().errorCode, 'CONTENT_ROOT_MISMATCH')

    const afterFailure = await fixture.app.inject({
      headers: {
        ...signedHeaders('PUT', chunkPath, chunk, 'nonce-mismatch-closing'),
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/octet-stream',
        'x-flowdrop-chunk-sha256': createHash('sha256').update(chunk).digest('hex')
      },
      method: 'PUT',
      payload: chunk,
      url: chunkPath
    })
    assert.equal(afterFailure.statusCode, 409)
    assert.deepEqual(afterFailure.json(), {code: 'TRANSFER_CLOSING'})
  } finally {
    await fixture.cleanup()
  }
})

test('migrates only V3 tables and reverses an empty V3 schema without touching legacy data', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(`
      CREATE TABLE transfers (transfer_id TEXT PRIMARY KEY, marker TEXT NOT NULL);
      INSERT INTO transfers (transfer_id, marker) VALUES ('legacy-001', 'preserved');
    `)
    migrateV3TransferDatabase(database)
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v3_transfers'").get())
    assert.equal(rollbackLatestV3TransferMigration(database), '002_v3_completion')
    assert.equal(rollbackLatestV3TransferMigration(database), '001_v3_initial')
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v3_transfers'").get(), undefined)
    const legacyRow = database.prepare('SELECT transfer_id, marker FROM transfers').get() as {marker: string; transfer_id: string}
    assert.equal(legacyRow.transfer_id, 'legacy-001')
    assert.equal(legacyRow.marker, 'preserved')
  } finally {
    database.close()
  }
})

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-route-'))
  const trustedDeviceStore = new TrustedDeviceStore(path.join(root, 'trusted-devices.sqlite'))
  trustedDeviceStore.upsert({
    deviceId: DEVICE_ID,
    deviceKind: 'mobile',
    deviceName: 'Android test device',
    pairedAt: Date.now(),
    receiveEnabled: true,
    updatedAt: Date.now()
  })
  trustedDeviceStore.setTransferSecret(DEVICE_ID, SECRET)

  const eventBus = new AgentEventBus()
  const trustedDeviceAccess = new V3TrustedDeviceAccessClient(trustedDeviceStore.databasePath)
  const transferService = new V3TransferService(
    trustedDeviceAccess,
    new V3TransferStore(path.join(root, 'transfers')),
    eventBus
  )
  const transferAuthenticator = new V3TransferAuthenticator(trustedDeviceAccess)
  const app = Fastify()
  app.addContentTypeParser('application/octet-stream', {parseAs: 'buffer'}, (_request, body, done) => done(null, body))
  app.decorate('v3TransferService', transferService)
  app.decorate('v3TransferAuthenticator', transferAuthenticator)
  registerLegacyTransferGoneRoutes(app)
  await app.register(v3TransportRoutes)
  await app.ready()

  return {
    app,
    cleanup: async () => {
      await app.close()
      await transferService.close()
      await trustedDeviceAccess.close()
      trustedDeviceStore.close()
      rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
    },
    eventBus,
    root,
    trustedDeviceStore
  }
}

function createRequest() {
  return {
    chunkSizeBytes: 1024 * 1024,
    items: [{
      itemId: 'item-001',
      mimeType: 'application/octet-stream',
      name: 'sample.bin',
      sizeBytes: 4
    }],
    protocol: 3,
    sourceDeviceId: DEVICE_ID,
    transferId: 'transfer-001'
  }
}

async function waitForTransferStatus(
  fixture: Fixture,
  statusPath: string,
  expectedStatus: string
): Promise<{
  errorCode?: string
  revision: number
  status: string
  verifyingBytes: number
  verifyingPhase: string
  verifyingTotalBytes: number
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fixture.app.inject({
      headers: signedHeaders('GET', statusPath, Buffer.alloc(0), `nonce-status-wait-${attempt}`),
      method: 'GET',
      url: statusPath
    })
    assert.equal(response.statusCode, 200)
    const snapshot = response.json() as {
      errorCode?: string
      revision: number
      status: string
      verifyingBytes: number
      verifyingPhase: string
      verifyingTotalBytes: number
    }
    if (snapshot.status === expectedStatus) return snapshot
    await delay(10)
  }
  throw new Error(`V3 transfer did not reach ${expectedStatus}.`)
}

function signedHeaders(method: string, requestPath: string, body: Buffer, nonce: string, secret = SECRET) {
  const timestamp = Date.now().toString()
  const signature = createV3RequestSignature(secret, {
    body,
    method,
    nonce,
    path: requestPath,
    timestamp
  })
  return {
    authorization: `FlowDrop-HMAC ${timestamp}:${nonce}:${signature}`,
    'x-flowdrop-source-device-id': DEVICE_ID
  }
}
