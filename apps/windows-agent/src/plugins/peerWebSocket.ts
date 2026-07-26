import type {FastifyPluginAsync, FastifyRequest} from 'fastify'

import type {PeerSocket} from '../realtime/peerConnectionManager'


type WebSocketRouteRegistrar = {
  get: (
    path: string,
    options: {websocket: true},
    handler: (socket: PeerSocket, request: FastifyRequest) => void
  ) => void
}

// The package is declared in package.json. require keeps this source type-checkable
// before the user installs the new dependency in the workspace.
const fastifyWebsocket = require('@fastify/websocket') as FastifyPluginAsync

export const peerWebSocketPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyWebsocket)

  const routes = fastify as unknown as WebSocketRouteRegistrar
  routes.get('/v1/peer', {websocket: true}, (socket, request) => {
    fastify.peerConnectionManager.register(socket, request.ip)
  })
}
