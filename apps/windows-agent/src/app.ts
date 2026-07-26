import path from 'node:path'
import AutoLoad, {type AutoloadPluginOptions} from '@fastify/autoload'
import {type FastifyInstance, type FastifyPluginAsync, type FastifyServerOptions} from 'fastify'
import * as Plugins from './plugins'
import {AGENT_ADMIN_PORT} from '@flowdrop/config'
import {createAdminApp} from './admin/createAdminApp'


export interface AppOptions extends FastifyServerOptions, Partial<AutoloadPluginOptions> {

}

// Pass --options via CLI arguments in command to enable these options.
export const options: AppOptions = {}

const app: FastifyPluginAsync<AppOptions> = async (fastify, _options) => {
  await fastify.register(Plugins.realtimePlugin)
  await fastify.register(Plugins.discoveryPlugin)
  await fastify.register(Plugins.pairingPlugin)
  await fastify.register(Plugins.transfersPlugin)
  await fastify.register(Plugins.peerWebSocketPlugin)
  await fastify.register(Plugins.sensibleAPI)

  await fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'routes')
  })

  let adminApp: FastifyInstance | null = null
  fastify.addHook('onReady', async () => {
    adminApp = createAdminApp(fastify)
    await adminApp.listen({host: '127.0.0.1', port: AGENT_ADMIN_PORT})
  })
  fastify.addHook('onClose', async () => {
    await adminApp?.close()
    adminApp = null
  })
}


export default app
