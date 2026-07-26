import fp from 'fastify-plugin'

import {TransferService} from '../transfers/transferService'
import {TransferAuthenticator} from '../transfers/transferAuthenticator'


declare module 'fastify' {
  interface FastifyInstance {
    transferService: TransferService
    transferAuthenticator: TransferAuthenticator
  }
}

export const transfersPlugin = fp(async (fastify) => {
  const transferService = new TransferService(fastify.trustedDeviceStore)
  const transferAuthenticator = new TransferAuthenticator(fastify.trustedDeviceStore)
  fastify.decorate('transferService', transferService)
  fastify.decorate('transferAuthenticator', transferAuthenticator)

  fastify.addHook('onClose', async () => {
    transferService.close()
  })
}, {dependencies: ['flowdrop-pairing'], name: 'flowdrop-transfers'})
