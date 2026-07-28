import fp from 'fastify-plugin'

import '../transfers/v3Fastify'
import {V3TransferAuthenticator} from '../transfers/v3TransferAuthenticator'
import {V3TransferService} from '../transfers/v3TransferService'
import {V3TrustedDeviceAccessClient} from '../transfers/v3TrustedDeviceAccess'
import {V3TextMessageService} from '../transfers/v3TextMessageService'

export const transfersPlugin = fp(async (fastify) => {
  const trustedDeviceAccess = new V3TrustedDeviceAccessClient(fastify.trustedDeviceStore.databasePath)
  const v3TransferService = new V3TransferService(trustedDeviceAccess, undefined, fastify.agentEventBus)
  const v3TransferAuthenticator = new V3TransferAuthenticator(trustedDeviceAccess)
  const v3TextMessageService = new V3TextMessageService(
    trustedDeviceAccess,
    () => fastify.discoveryBroadcaster.deviceId,
    undefined,
    fastify.agentEventBus
  )
  fastify.decorate('v3TransferService', v3TransferService)
  fastify.decorate('v3TransferAuthenticator', v3TransferAuthenticator)
  fastify.decorate('v3TextMessageService', v3TextMessageService)

  fastify.addHook('onClose', async () => {
    try {
      await Promise.all([v3TransferService.close(), v3TextMessageService.close()])
    } finally {
      await trustedDeviceAccess.close()
    }
  })
}, {dependencies: ['flowdrop-pairing', 'flowdrop-realtime'], name: 'flowdrop-transfers'})
