import fastifyStatic from '@fastify/static'
import Fastify, {type FastifyInstance} from 'fastify'
import path from 'node:path'

import type {AgentEvent, PairingApprovalStatusResponse} from '@flowdrop/types'
import {initiateMobilePairing} from '../pairing/mobilePairingInitiator'


export function createAdminApp(peer: FastifyInstance): FastifyInstance {
  const admin = Fastify({logger: true})
  admin.addHook('onRequest', async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      return reply.code(403).send({message: 'The Agent admin service is only available on this computer.'})
    }
  })

  admin.get('/api/devices', async () => {
    const trustedDevices = peer.trustedDeviceStore.list()
    const trustedById = new Map(trustedDevices.map((device) => [device.deviceId, device]))
    const devices = peer.discoveryBroadcaster.getDiscoveredDevices().map((device) => ({
      ...device,
      trustedDevice: trustedById.get(device.deviceId) ?? null
    }))
    return {devices, trustedDevices}
  })

  admin.get('/api/trusted-devices', async () => ({devices: peer.trustedDeviceStore.list()}))

  admin.patch('/api/paired-devices/:deviceId/receive-permission', async (request, reply) => {
    const {deviceId} = request.params as {deviceId: string}
    const body = request.body as {receiveEnabled?: unknown}
    if (!isValidDeviceId(deviceId) || typeof body?.receiveEnabled !== 'boolean') {
      return reply.code(400).send({message: 'A device ID and receiveEnabled boolean are required.'})
    }

    const device = peer.trustedDeviceStore.setReceiveEnabled(deviceId, body.receiveEnabled)
    if (!device) return reply.code(404).send({message: 'The paired device does not exist.'})

    peer.agentEventBus.publish({payload: device, type: 'permission.changed'})
    return {device}
  })

  admin.get('/api/admin/events', async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
      'x-accel-buffering': 'no'
    })
    reply.raw.write(': connected\n\n')

    const writeEvent = (event: AgentEvent) => {
      reply.raw.write(`id: ${event.eventId}\n`)
      reply.raw.write(`event: ${event.type}\n`)
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    const lastEventId = request.headers['last-event-id']
    for (const event of peer.agentEventBus.getEventsAfter(
      typeof lastEventId === 'string' ? lastEventId : undefined
    )) {
      writeEvent(event)
    }
    const unsubscribe = peer.agentEventBus.subscribe(writeEvent)
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 20_000)
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  admin.post('/api/pairing/sessions', async (_request, reply) => {
    const session = peer.pairingService.createSession()
    return reply.code(201).send({session})
  })

  admin.post('/api/discovered-devices/:deviceId/pair', async (request, reply) => {
    const {deviceId} = request.params as {deviceId: string}
    const {code} = request.body as {code?: unknown}
    const device = peer.discoveryBroadcaster.getDiscoveredDevices().find((candidate) => candidate.deviceId === deviceId)
    const agentDeviceId = peer.discoveryBroadcaster.deviceId
    if (!device || !agentDeviceId || typeof code !== 'string') {
      return reply.code(400).send({message: 'A discovered device and a six-digit pairing code are required.'})
    }

    try {
      const trustedDevice = await initiateMobilePairing(device, code, agentDeviceId, peer.trustedDeviceStore)
      peer.agentEventBus.publish({payload: trustedDevice, type: 'device.changed'})
      return {device: trustedDevice}
    } catch (error) {
      return reply.code(400).send({message: error instanceof Error ? error.message : 'Unable to pair with the mobile device.'})
    }
  })

  admin.get('/api/pairing/requests', async () => ({
    requests: peer.pairingService.getPendingPairingRequests()
  }))

  admin.get('/api/pairing/requests/:requestId', async (request, reply) => {
    const {requestId} = request.params as {requestId: string}
    const status = peer.pairingService.getPairingRequestStatus(requestId)
    if (!status) return reply.code(404).send({message: 'Pairing request was not found.'})

    const response: PairingApprovalStatusResponse = {status}
    return response
  })

  admin.post('/api/pairing/requests/:requestId/approve', async (request, reply) => {
    const {requestId} = request.params as {requestId: string}
    if (!peer.pairingService.approvePairingRequest(requestId)) {
      return reply.code(404).send({message: 'Pairing request was not found or has expired.'})
    }
    return reply.code(204).send()
  })

  admin.post('/api/pairing/requests/:requestId/reject', async (request, reply) => {
    const {requestId} = request.params as {requestId: string}
    if (!peer.pairingService.rejectPairingRequest(requestId)) {
      return reply.code(404).send({message: 'Pairing request was not found or has expired.'})
    }
    return reply.code(204).send()
  })

  admin.register(fastifyStatic, {
    decorateReply: false,
    prefix: '/',
    root: path.join(__dirname, '..', '..', 'public')
  })
  return admin
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}
