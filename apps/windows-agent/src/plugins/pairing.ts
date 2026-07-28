import fp from 'fastify-plugin'

import {PairingService} from '../pairing/pairingService'
import {PeerConnectionManager} from '../realtime/peerConnectionManager'
import {TrustedDeviceStore} from '../storage/trustedDeviceStore'
import {V3TrustedDeviceAccessClient} from '../transfers/v3TrustedDeviceAccess'


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
  const trustedDeviceAccess = new V3TrustedDeviceAccessClient(trustedDeviceStore.databasePath)
  const peerConnectionManager = new PeerConnectionManager(fastify.agentEventBus, pairingService, trustedDeviceAccess)

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
    await trustedDeviceAccess.close()
    trustedDeviceStore.close()
  })
}, {name: 'flowdrop-pairing'})
