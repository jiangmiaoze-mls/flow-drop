import type {V3TransferAuthenticator} from './v3TransferAuthenticator'
import type {V3TransferService} from './v3TransferService'
import type {V3TextMessageService} from './v3TextMessageService'

declare module 'fastify' {
  interface FastifyInstance {
    v3TransferAuthenticator: V3TransferAuthenticator
    v3TransferService: V3TransferService
    v3TextMessageService: V3TextMessageService
  }
}

export {}
