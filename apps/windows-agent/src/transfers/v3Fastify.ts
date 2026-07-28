import type {V3TransferAuthenticator} from './v3TransferAuthenticator'
import type {V3OutgoingTransferService} from './v3OutgoingTransferService'
import type {V3TransferService} from './v3TransferService'
import type {V3TextMessageService} from './v3TextMessageService'
import type {AgentEventBus} from '../realtime/agentEventBus'

declare module 'fastify' {
  interface FastifyInstance {
    agentEventBus: AgentEventBus
    v3TransferAuthenticator: V3TransferAuthenticator
    v3OutgoingTransferService: V3OutgoingTransferService
    v3TransferService: V3TransferService
    v3TextMessageService: V3TextMessageService
  }
}

export {}
