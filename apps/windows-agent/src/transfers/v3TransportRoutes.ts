import type {FastifyInstance, FastifyPluginAsync, FastifyRequest} from 'fastify'

import {assertCanonicalJsonBody} from './v3CanonicalJson'
import './v3Fastify'
import {V3TransportError} from './v3TransportError'
import {parseV3ChunkIndex, parseV3ContentRange} from './v3TransferService'
import {V3_MAX_CREATE_BODY_BYTES} from './v3TransportTypes'

export const v3TransportRoutes: FastifyPluginAsync = async (fastify) => {
  const rawBodies = new WeakMap<object, Buffer>()
  const secureJsonParser = fastify.getDefaultJsonParser('error', 'error')

  fastify.removeContentTypeParser('application/json')
  fastify.addContentTypeParser('application/json', {
    bodyLimit: V3_MAX_CREATE_BODY_BYTES,
    parseAs: 'buffer'
  }, (request, rawBody, done) => {
    if (!Buffer.isBuffer(rawBody)) {
      done(new V3TransportError('INVALID_TRANSFER', 400))
      return
    }
    rawBodies.set(request, rawBody)
    secureJsonParser(request, rawBody.toString('utf8'), done)
  })

  fastify.get('/v1/transport/capabilities', async (request, reply) => {
    try {
      const requestPath = getRequestTarget(request)
      if (requestPath !== '/v1/transport/capabilities') throw new V3TransportError('INVALID_TRANSPORT_REQUEST', 400)
      const sourceDeviceId = await authenticateRequest(fastify, request, 'GET', requestPath, Buffer.alloc(0))
      return reply.send(await fastify.v3TransferService.getCapabilities(sourceDeviceId))
    } catch (error) {
      return sendV3Error(reply, error)
    }
  })

  fastify.post('/v3/transfers', async (request, reply) => {
    try {
      const requestPath = getRequestTarget(request)
      if (requestPath !== '/v3/transfers') throw new V3TransportError('INVALID_TRANSFER', 400)
      const rawBody = requireRawBody(rawBodies, request)
      const sourceDeviceId = await authenticateRequest(fastify, request, 'POST', requestPath, rawBody)
      assertCanonicalJsonBody(rawBody, request.body)
      const result = await fastify.v3TransferService.createIncomingTransfer(request.body, sourceDeviceId)
      return reply.code(result.created ? 201 : 200).send(result.response)
    } catch (error) {
      return sendV3Error(reply, error)
    }
  })

  fastify.put('/v3/transfers/:transferId/items/:itemId/chunks/:chunkIndex', async (request, reply) => {
    try {
      const requestPath = getRequestTarget(request)
      const {chunkIndex: rawChunkIndex, itemId, transferId} = request.params as {
        chunkIndex: string
        itemId: string
        transferId: string
      }
      const chunkIndex = parseV3ChunkIndex(rawChunkIndex)
      if (chunkIndex === null || requestPath !== `/v3/transfers/${transferId}/items/${itemId}/chunks/${chunkIndex}`) {
        throw new V3TransportError('INVALID_CHUNK', 400)
      }
      const contentRange = parseV3ContentRange(request.headers['content-range'])
      const chunkSha256 = request.headers['x-flowdrop-chunk-sha256']
      if (!contentRange || typeof chunkSha256 !== 'string' || !Buffer.isBuffer(request.body)) {
        throw new V3TransportError('INVALID_CHUNK_REQUEST', 400)
      }
      const sourceDeviceId = await authenticateRequest(fastify, request, 'PUT', requestPath, request.body)
      const response = await fastify.v3TransferService.uploadChunk(
        transferId,
        itemId,
        chunkIndex,
        sourceDeviceId,
        contentRange,
        request.body,
        chunkSha256
      )
      return reply.send(response)
    } catch (error) {
      return sendV3Error(reply, error)
    }
  })

  fastify.get('/v3/transfers/:transferId/status', async (request, reply) => {
    try {
      const {transferId} = request.params as {transferId: string}
      const requestPath = getRequestTarget(request)
      if (!isRouteIdentifier(transferId) || requestPath !== `/v3/transfers/${transferId}/status`) {
        throw new V3TransportError('INVALID_TRANSPORT_REQUEST', 400)
      }
      const sourceDeviceId = await authenticateRequest(fastify, request, 'GET', requestPath, Buffer.alloc(0))
      return reply.send(await fastify.v3TransferService.getIncomingTransferStatus(transferId, sourceDeviceId))
    } catch (error) {
      return sendV3Error(reply, error)
    }
  })

  for (const operation of ['pause', 'resume', 'cancel'] as const) {
    fastify.post(`/v3/transfers/:transferId/${operation}`, async (request, reply) => {
      try {
        const {transferId} = request.params as {transferId: string}
        const requestPath = getRequestTarget(request)
        if (!isRouteIdentifier(transferId) || requestPath !== `/v3/transfers/${transferId}/${operation}`) {
          throw new V3TransportError('INVALID_TRANSPORT_REQUEST', 400)
        }
        const rawBody = getControlRawBody(rawBodies, request)
        const sourceDeviceId = await authenticateRequest(fastify, request, 'POST', requestPath, rawBody)
        assertEmptyControlBody(rawBody, request.body)
        switch (operation) {
          case 'pause':
            return reply.send(await fastify.v3TransferService.pauseIncomingTransfer(transferId, sourceDeviceId))
          case 'resume':
            return reply.send(await fastify.v3TransferService.resumeIncomingTransfer(transferId, sourceDeviceId))
          case 'cancel':
            return reply.send(await fastify.v3TransferService.cancelIncomingTransfer(transferId, sourceDeviceId))
        }
      } catch (error) {
        return sendV3Error(reply, error)
      }
    })
  }

  fastify.get('/v3/transfers/:transferId/items/:itemId/chunk-digests', async (request, reply) => {
    try {
      const {itemId, transferId} = request.params as {itemId: string; transferId: string}
      const requestTarget = getRequestTarget(request, true)
      if (!isRouteIdentifier(transferId) || !isRouteIdentifier(itemId)) {
        throw new V3TransportError('INVALID_CHUNK_DIGEST_PAGE', 400)
      }
      const routePath = `/v3/transfers/${transferId}/items/${itemId}/chunk-digests`
      const page = parseChunkDigestPage(requestTarget, routePath)
      if (!page) throw new V3TransportError('INVALID_CHUNK_DIGEST_PAGE', 400)

      // The HMAC path is the signed raw target, including its canonical query string.
      const sourceDeviceId = await authenticateRequest(fastify, request, 'GET', requestTarget, Buffer.alloc(0))
      return reply.send(await fastify.v3TransferService.getIncomingChunkDigests(
        transferId,
        itemId,
        sourceDeviceId,
        page.offset,
        page.limit
      ))
    } catch (error) {
      return sendV3Error(reply, error)
    }
  })

  fastify.post('/v3/transfers/:transferId/complete', async (request, reply) => {
    try {
      const {transferId} = request.params as {transferId: string}
      const requestPath = getRequestTarget(request)
      if (!isRouteIdentifier(transferId) || requestPath !== `/v3/transfers/${transferId}/complete`) {
        throw new V3TransportError('INVALID_COMPLETION_FILES', 400)
      }
      const rawBody = requireRawBody(rawBodies, request)
      const sourceDeviceId = await authenticateRequest(fastify, request, 'POST', requestPath, rawBody)
      assertCanonicalJsonBody(rawBody, request.body)
      const result = await fastify.v3TransferService.completeIncomingTransfer(transferId, request.body, sourceDeviceId)
      return reply.code(result.statusCode).send(result.response)
    } catch (error) {
      return sendV3Error(reply, error)
    }
  })
}

export function registerLegacyTransferGoneRoutes(fastify: FastifyInstance) {
  const legacyPaths = [
    '/api/transfers/admission',
    '/v1/transfers',
    '/v1/transfers/*',
    '/v2/transfers',
    '/v2/transfers/*'
  ]
  for (const path of legacyPaths) {
    fastify.all(path, async (_request, reply) => reply.code(410).send({code: 'TRANSFER_PROTOCOL_GONE'}))
  }
}

async function authenticateRequest(
  fastify: FastifyInstance,
  request: FastifyRequest,
  method: string,
  path: string,
  body: Buffer
): Promise<string> {
  return fastify.v3TransferAuthenticator.authenticate({
    authorization: request.headers.authorization,
    body,
    method,
    path,
    sourceDeviceId: request.headers['x-flowdrop-source-device-id']
  })
}

function getRequestTarget(request: FastifyRequest, allowQuery = false): string {
  const requestTarget = request.raw.url ?? ''
  if (!requestTarget.startsWith('/') || (!allowQuery && requestTarget.includes('?'))) {
    throw new V3TransportError('INVALID_TRANSPORT_REQUEST', 400)
  }
  return requestTarget
}

function requireRawBody(rawBodies: WeakMap<object, Buffer>, request: FastifyRequest): Buffer {
  const body = rawBodies.get(request)
  if (!body) throw new V3TransportError('INVALID_TRANSFER', 400)
  return body
}

function getControlRawBody(rawBodies: WeakMap<object, Buffer>, request: FastifyRequest): Buffer {
  const rawBody = rawBodies.get(request)
  if (rawBody) return rawBody
  const contentLength = request.headers['content-length']
  const declaredLength = typeof contentLength === 'string' ? Number(contentLength) : NaN
  if ((Number.isSafeInteger(declaredLength) && declaredLength > 0) || request.body !== undefined) {
    throw new V3TransportError('INVALID_CONTROL_REQUEST', 400)
  }
  return Buffer.alloc(0)
}

function assertEmptyControlBody(rawBody: Buffer, body: unknown) {
  if (rawBody.length === 0) {
    if (body !== undefined) throw new V3TransportError('INVALID_CONTROL_REQUEST', 400)
    return
  }
  assertCanonicalJsonBody(rawBody, body)
  if (!isEmptyObject(body)) throw new V3TransportError('INVALID_CONTROL_REQUEST', 400)
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

function sendV3Error(reply: {code: (statusCode: number) => {send: (payload: unknown) => unknown}}, error: unknown) {
  if (error instanceof V3TransportError) {
    return reply.code(error.statusCode).send({code: error.code})
  }
  return reply.code(500).send({code: 'TRANSFER_INTERNAL_ERROR'})
}

function parseChunkDigestPage(
  requestTarget: string,
  routePath: string
): {limit: number; offset: number} | null {
  const match = new RegExp(`^${escapeRegExp(routePath)}\\?offset=(0|[1-9]\\d*)&limit=([1-9]\\d*)$`).exec(requestTarget)
  if (!match) return null
  const offset = Number(match[1])
  const limit = Number(match[2])
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit > 1000) return null
  return {limit, offset}
}

function isRouteIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
