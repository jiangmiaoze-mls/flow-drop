import fp from 'fastify-plugin'

import '../transfers/v3Fastify'
import {V3TransferAuthenticator} from '../transfers/v3TransferAuthenticator'
import {V3TransferService} from '../transfers/v3TransferService'
import {V3TrustedDeviceAccessClient} from '../transfers/v3TrustedDeviceAccess'

export const transfersPlugin = fp(async (fastify) => {
  const trustedDeviceAccess = new V3TrustedDeviceAccessClient(fastify.trustedDeviceStore.databasePath)
  const v3TransferService = new V3TransferService(trustedDeviceAccess, undefined, fastify.agentEventBus)
  const v3TransferAuthenticator = new V3TransferAuthenticator(trustedDeviceAccess)
  fastify.decorate('v3TransferService', v3TransferService)
  fastify.decorate('v3TransferAuthenticator', v3TransferAuthenticator)

  fastify.addHook('onClose', async () => {
    try {
      await v3TransferService.close()
    } finally {
      await trustedDeviceAccess.close()
    }
  })
}, {dependencies: ['flowdrop-pairing', 'flowdrop-realtime'], name: 'flowdrop-transfers'})
