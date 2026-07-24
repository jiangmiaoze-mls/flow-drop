import fastifyStatic from '@fastify/static'
import fp from 'fastify-plugin'
import path from 'node:path'


export const staticPlugin = fp(async (fastify, opts) => {
  const publicDir = path.join(__dirname, '..', '..', 'public')

  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    decorateReply: true
  })
})
