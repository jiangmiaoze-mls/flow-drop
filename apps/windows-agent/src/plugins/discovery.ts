import fp from 'fastify-plugin'

import {DiscoveryBroadcaster} from '../network/discoveryBroadcaster'


export const discoveryPlugin = fp(async (fastify) => {
  const broadcaster = new DiscoveryBroadcaster({
    onDiscoveryEvent: (event) => {
      if (event.type === 'error') return
      fastify.log.info({device: event.device}, `UDP discovery ${event.type}`)
    },
    onError: (error) => fastify.log.error({err: error}, 'UDP discovery broadcaster error')
  })

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
