import type {V3TransferAuthenticator} from './v3TransferAuthenticator'
import type {V3TransferService} from './v3TransferService'

declare module 'fastify' {
  interface FastifyInstance {
    v3TransferAuthenticator: V3TransferAuthenticator
    v3TransferService: V3TransferService
  }
}

export {}
