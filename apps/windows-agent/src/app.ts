import path from 'node:path'
import AutoLoad, {type AutoloadPluginOptions} from '@fastify/autoload'
import {type FastifyPluginAsync, type FastifyServerOptions} from 'fastify'
import * as Plugins from './plugins'
import {DISCOVERY_PORT} from '@flowdrop/config'


export interface AppOptions extends FastifyServerOptions, Partial<AutoloadPluginOptions> {

}

// Pass --options via CLI arguments in command to enable these options.
export const options: AppOptions = {}

const app: FastifyPluginAsync<AppOptions> = async (fastify, _options) => {
  await fastify.register(Plugins.discoveryPlugin)
  await fastify.register(Plugins.sensibleAPI)
  await fastify.register(Plugins.staticPlugin)

  await fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'routes')
  })
}


export default app
