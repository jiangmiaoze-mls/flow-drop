import {type FastifyPluginAsync} from 'fastify'

import type {
  PairingApprovalStatusResponse,
  PairingVerificationRequest,
  TransferAdmissionRequest,
  TransferAdmissionResponse
} from '@flowdrop/types'

const root: FastifyPluginAsync = async (fastify): Promise<void> => {
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
}

function isTransferAdmissionRequest(value: unknown): value is TransferAdmissionRequest {
  if (!value || typeof value !== 'object') return false
  const sourceDeviceId = (value as Record<string, unknown>).sourceDeviceId
  return typeof sourceDeviceId === 'string' && sourceDeviceId.trim().length > 0 && sourceDeviceId.length <= 128
}

export default root
