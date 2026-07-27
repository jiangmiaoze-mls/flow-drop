import {type FastifyPluginAsync} from 'fastify'

import type {
  PairingApprovalStatusResponse,
  PairingVerificationRequest
} from '@flowdrop/types'
import {V3_MAX_CHUNK_BYTES} from '../transfers/v3TransportTypes'
import {registerLegacyTransferGoneRoutes, v3TransportRoutes} from '../transfers/v3TransportRoutes'

const root: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addContentTypeParser('application/octet-stream', {
    bodyLimit: V3_MAX_CHUNK_BYTES,
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

  registerLegacyTransferGoneRoutes(fastify)
  await fastify.register(v3TransportRoutes)
}

export default root
