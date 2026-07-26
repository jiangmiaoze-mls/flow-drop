import {type FastifyPluginAsync} from 'fastify'

import type {
  CreateTransferRequest,
  PairingApprovalStatusResponse,
  PairingVerificationRequest,
  TransferAdmissionRequest,
  TransferAdmissionResponse
} from '@flowdrop/types'
import {MAX_CHUNK_BYTES} from '../transfers/transferStore'
import {parseContentRange, TransferServiceError} from '../transfers/transferService'

const root: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addContentTypeParser('application/octet-stream', {
    bodyLimit: MAX_CHUNK_BYTES,
    parseAs: 'buffer'
  }, (_request, body, done) => done(null, body))

  fastify.get('/', async () => ({service: 'flowdrop-peer'}))

  // REST remains a compatibility fallback. Mobile pairing uses /v1/peer WebSocket.
  fastify.post('/api/pairing/verify', async (request, reply) => {
    const pairingRequest = request.body as PairingVerificationRequest
    const result = fastify.pairingService.requestPairingApproval(pairingRequest, request.ip)
    if (result.status === 'invalid') {
      return reply.code(400).send({code: 'INVALID_PAIRING_CODE', message: 'Invalid, expired, or exhausted pairing code.'})
    }

    fastify.agentEventBus.publish({payload: result.request, type: 'pairing.requested'})
    return reply.code(202).send({request: result.request})
  })

  fastify.get('/api/pairing/requests/:requestId', async (request, reply) => {
    const {requestId} = request.params as {requestId: string}
    const status = fastify.pairingService.getPairingRequestStatus(requestId)
    if (!status) {
      return reply.code(404).send({code: 'PAIRING_REQUEST_NOT_FOUND', message: 'Pairing request was not found.'})
    }

    const response: PairingApprovalStatusResponse = {status}
    return response
  })

  fastify.post('/api/transfers/admission', async (request, reply) => {
    const transferRequest = request.body as TransferAdmissionRequest
    if (!isTransferAdmissionRequest(transferRequest)) {
      return reply.code(400).send({message: 'A valid source device ID is required.'})
    }

    const pairedDevice = fastify.trustedDeviceStore.get(transferRequest.sourceDeviceId)
    if (!pairedDevice) {
      const response: TransferAdmissionResponse = {
        accepted: false,
        code: 'DEVICE_NOT_PAIRED',
        message: 'The source device is not paired with this Agent.'
      }
      return reply.code(403).send(response)
    }
    if (!pairedDevice.receiveEnabled) {
      const response: TransferAdmissionResponse = {
        accepted: false,
        code: 'TRANSFER_RECEIVE_DISABLED',
        message: 'This Agent is not accepting transfers from the source device.'
      }
      return reply.code(403).send(response)
    }

    const response: TransferAdmissionResponse = {accepted: true}
    return reply.send(response)
  })

  // Peer transport stays separate from local admin APIs and requires a pairing credential signature.
  fastify.post('/v1/transfers', async (request, reply) => {
    try {
      const sourceDeviceId = authenticateTransferRequest(fastify, request, 'POST', '/v1/transfers', JSON.stringify(request.body))
      const transferRequest = request.body as CreateTransferRequest
      if (transferRequest.sourceDeviceId !== sourceDeviceId) return reply.code(403).send({code: 'TRANSFER_FORBIDDEN'})
      const response = fastify.transferService.createIncomingTransfer(transferRequest)
      fastify.agentEventBus.publish({payload: response.task, type: 'transfer.changed'})
      return reply.code(201).send(response)
    } catch (error) {
      publishTransferRejection(fastify, 'create', request.body, error)
      return sendTransferError(reply, error)
    }
  })

  fastify.get('/v1/transfers/:transferId', async (request, reply) => {
    try {
      const {transferId} = request.params as {transferId: string}
      const sourceDeviceId = authenticateTransferRequest(fastify, request, 'GET', `/v1/transfers/${transferId}`, '')
      const response = fastify.transferService.getIncomingTransfer(transferId, sourceDeviceId)
      return reply.send(response)
    } catch (error) {
      return sendTransferError(reply, error)
    }
  })

  fastify.put('/v1/transfers/:transferId/items/:itemId/chunks/:chunkIndex', async (request, reply) => {
    try {
      const contentRange = parseContentRange(request.headers['content-range'])
      const chunkSha256 = request.headers['x-flowdrop-chunk-sha256']
      if (!contentRange || typeof chunkSha256 !== 'string' || !Buffer.isBuffer(request.body)) {
        return reply.code(400).send({code: 'INVALID_CHUNK_REQUEST'})
      }
      const {chunkIndex, itemId, transferId} = request.params as {chunkIndex: string; itemId: string; transferId: string}
      const sourceDeviceId = authenticateTransferRequest(fastify, request, 'PUT', `/v1/transfers/${transferId}/items/${itemId}/chunks/${chunkIndex}`, request.body)
      const response = fastify.transferService.uploadChunk(
        transferId,
        itemId,
        Number(chunkIndex),
        sourceDeviceId,
        contentRange,
        request.body,
        chunkSha256
      )
      fastify.agentEventBus.publish({payload: response.task, type: 'transfer.changed'})
      return reply.send(response)
    } catch (error) {
      publishTransferRejection(fastify, 'chunk', request.params, error)
      return sendTransferError(reply, error)
    }
  })

  fastify.post('/v1/transfers/:transferId/complete', async (request, reply) => {
    try {
      const {transferId} = request.params as {transferId: string}
      const sourceDeviceId = authenticateTransferRequest(fastify, request, 'POST', `/v1/transfers/${transferId}/complete`, '')
      const response = await fastify.transferService.completeIncomingTransfer(transferId, sourceDeviceId)
      fastify.agentEventBus.publish({payload: response.task, type: 'transfer.changed'})
      return reply.send(response)
    } catch (error) {
      publishTransferRejection(fastify, 'complete', request.params, error)
      return sendTransferError(reply, error)
    }
  })

  fastify.post('/v1/transfers/:transferId/cancel', async (request, reply) => {
    try {
      const {transferId} = request.params as {transferId: string}
      const sourceDeviceId = authenticateTransferRequest(fastify, request, 'POST', `/v1/transfers/${transferId}/cancel`, '')
      const response = fastify.transferService.cancelIncomingTransfer(transferId, sourceDeviceId)
      fastify.agentEventBus.publish({payload: response.task, type: 'transfer.changed'})
      return reply.send(response)
    } catch (error) {
      publishTransferRejection(fastify, 'cancel', request.params, error)
      return sendTransferError(reply, error)
    }
  })

  fastify.post('/v1/transfers/:transferId/pause', async (request, reply) => {
    try {
      const {transferId} = request.params as {transferId: string}
      const sourceDeviceId = authenticateTransferRequest(fastify, request, 'POST', `/v1/transfers/${transferId}/pause`, '')
      const response = fastify.transferService.pauseIncomingTransfer(transferId, sourceDeviceId)
      fastify.agentEventBus.publish({payload: response.task, type: 'transfer.changed'})
      return reply.send(response)
    } catch (error) {
      publishTransferRejection(fastify, 'pause', request.params, error)
      return sendTransferError(reply, error)
    }
  })

  fastify.post('/v1/transfers/:transferId/resume', async (request, reply) => {
    try {
      const {transferId} = request.params as {transferId: string}
      const sourceDeviceId = authenticateTransferRequest(fastify, request, 'POST', `/v1/transfers/${transferId}/resume`, '')
      const response = fastify.transferService.resumeIncomingTransfer(transferId, sourceDeviceId)
      fastify.agentEventBus.publish({payload: response.task, type: 'transfer.changed'})
      return reply.send(response)
    } catch (error) {
      publishTransferRejection(fastify, 'resume', request.params, error)
      return sendTransferError(reply, error)
    }
  })
}

function isTransferAdmissionRequest(value: unknown): value is TransferAdmissionRequest {
  if (!value || typeof value !== 'object') return false
  const sourceDeviceId = (value as Record<string, unknown>).sourceDeviceId
  return typeof sourceDeviceId === 'string' && sourceDeviceId.trim().length > 0 && sourceDeviceId.length <= 128
}

function authenticateTransferRequest(
  fastify: {transferAuthenticator: {authenticate: (input: {body: Buffer | string; method: string; nonce: unknown; path: string; signature: unknown; sourceDeviceId: unknown; timestamp: unknown}) => string}},
  request: {headers: Record<string, unknown>},
  method: string,
  path: string,
  body: Buffer | string
) {
  return fastify.transferAuthenticator.authenticate({
    body,
    method,
    nonce: request.headers['x-flowdrop-nonce'],
    path,
    signature: request.headers['x-flowdrop-signature'],
    sourceDeviceId: request.headers['x-flowdrop-source-device-id'],
    timestamp: request.headers['x-flowdrop-timestamp']
  })
}

function sendTransferError(reply: {code: (statusCode: number) => {send: (payload: unknown) => unknown}}, error: unknown) {
  if (error instanceof TransferServiceError) {
    return reply.code(error.statusCode).send({code: error.code})
  }
  if (error instanceof Error && error.message === 'CHUNK_CONFLICT') {
    return reply.code(409).send({code: error.message})
  }
  if (error instanceof Error && (error.message === 'TRANSFER_ITEM_NOT_FOUND' || error.message === 'CHUNK_RANGE_INVALID')) {
    return reply.code(400).send({code: error.message})
  }
  if (error instanceof Error && error.message === 'TRANSFER_PAUSED') {
    return reply.code(409).send({code: error.message})
  }
  return reply.code(500).send({code: 'TRANSFER_INTERNAL_ERROR'})
}

function publishTransferRejection(
  fastify: {agentEventBus: {publish: (event: {payload: unknown; type: 'transfer.changed'}) => unknown}},
  operation: 'cancel' | 'chunk' | 'complete' | 'create' | 'pause' | 'resume',
  request: unknown,
  error: unknown
) {
  fastify.agentEventBus.publish({
    payload: {
      code: error instanceof TransferServiceError ? error.code : 'TRANSFER_INTERNAL_ERROR',
      operation,
      status: 'rejected',
      transferId: getRequestTransferId(request)
    },
    type: 'transfer.changed'
  })
}

function getRequestTransferId(request: unknown): string | undefined {
  if (!request || typeof request !== 'object') return undefined
  const transferId = (request as Record<string, unknown>).transferId
  return typeof transferId === 'string' ? transferId : undefined
}

export default root
