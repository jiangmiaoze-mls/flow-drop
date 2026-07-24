import sensible, { type FastifySensibleOptions } from '@fastify/sensible'
import fp from 'fastify-plugin'


export const sensibleAPI = fp<FastifySensibleOptions>(async (fastify, opts) => {
  await fastify.register(sensible)
})
