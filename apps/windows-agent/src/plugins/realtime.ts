import fp from 'fastify-plugin'

import {AgentEventBus} from '../realtime/agentEventBus'


declare module 'fastify' {
  interface FastifyInstance {
    agentEventBus: AgentEventBus
  }
}

export const realtimePlugin = fp(async (fastify) => {
  fastify.decorate('agentEventBus', new AgentEventBus())
}, {name: 'flowdrop-realtime'})
