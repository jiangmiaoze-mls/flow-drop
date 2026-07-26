import fp from 'fastify-plugin'

import {PairingService} from '../pairing/pairingService'
import {PeerConnectionManager} from '../realtime/peerConnectionManager'
import {TrustedDeviceStore} from '../storage/trustedDeviceStore'


declare module 'fastify' {
  interface FastifyInstance {
    pairingService: PairingService
    peerConnectionManager: PeerConnectionManager
    trustedDeviceStore: TrustedDeviceStore
  }
}

export const pairingPlugin = fp(async (fastify) => {
  const trustedDeviceStore = new TrustedDeviceStore()
  const pairingService = new PairingService(trustedDeviceStore)
  const peerConnectionManager = new PeerConnectionManager(fastify.agentEventBus, pairingService)

  fastify.decorate('pairingService', pairingService)
  fastify.decorate('peerConnectionManager', peerConnectionManager)
  const unsubscribeFromResolutions = pairingService.subscribeToResolutions((resolution) => {
    peerConnectionManager.sendPairingResolution(resolution)
  })
  fastify.decorate('trustedDeviceStore', trustedDeviceStore)

  fastify.addHook('onClose', async () => {
    unsubscribeFromResolutions()
    peerConnectionManager.closeAll()
    pairingService.close()
    trustedDeviceStore.close()
  })
}, {name: 'flowdrop-pairing'})
