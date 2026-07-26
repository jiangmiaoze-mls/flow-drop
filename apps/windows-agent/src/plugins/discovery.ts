import fp from 'fastify-plugin'

import {DiscoveryBroadcaster} from '../network/discoveryBroadcaster'


declare module 'fastify' {
  interface FastifyInstance {
    discoveryBroadcaster: DiscoveryBroadcaster
  }
}

export const discoveryPlugin = fp(async (fastify) => {
  const broadcaster = new DiscoveryBroadcaster({
    onDiscoveryEvent: (event) => {
      fastify.agentEventBus.publish({
        payload: event,
        type: 'device.changed'
      })
    },
    onError: (error) => fastify.log.error({err: error}, 'UDP discovery broadcaster error')
  })

  fastify.decorate('discoveryBroadcaster', broadcaster)

  fastify.addHook('onReady', async () => {
    try {
      await broadcaster.start()
      fastify.log.info({deviceId: broadcaster.deviceId}, 'UDP discovery broadcaster started')
    } catch (error) {
      fastify.log.error({err: error}, 'Unable to start UDP discovery broadcaster')
    }
  })

  fastify.addHook('onClose', async () => {
    await broadcaster.stop()
  })
}, {name: 'flowdrop-discovery'})
