import {createHash} from 'node:crypto'

const V3_CONTENT_ROOT_DIGEST_BYTES = 32
const V3_LEAF_PREFIX = Buffer.from('FlowDrop-V3-leaf\0', 'utf8')
const V3_ROOT_PREFIX = Buffer.from('FlowDrop-V3-root\0', 'utf8')

export type V3ContentRootDigestChunk = {
  index: number
  length: number
  sha256: Uint8Array
}

export type V3ContentRootHexDigestChunk = {
  index: number
  length: number
  sha256: string
}

export type V3ContentRootInput = {
  chunkSizeBytes: number
  chunks: readonly V3ContentRootDigestChunk[]
  fileSizeBytes: number
}

export type V3ContentRootHexInput = {
  chunkSizeBytes: number
  chunks: readonly V3ContentRootHexDigestChunk[]
  fileSizeBytes: number
}

/**
 * Returns ceil(fileSizeBytes / chunkSizeBytes). Both inputs are constrained to
 * JavaScript safe integers because they originate in the V3 transfer schema.
 */
export function getV3ContentRootChunkCount(fileSizeBytes: number, chunkSizeBytes: number): number {
  assertFileSize(fileSizeBytes)
  assertChunkSize(chunkSizeBytes)
  return Math.ceil(fileSizeBytes / chunkSizeBytes)
}

export function getV3ContentRootChunkLength(
  fileSizeBytes: number,
  chunkSizeBytes: number,
  chunkIndex: number
): number {
  const chunkCount = getV3ContentRootChunkCount(fileSizeBytes, chunkSizeBytes)
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
    throw new RangeError('V3 content root chunk index is outside the file range.')
  }
  const start = chunkIndex * chunkSizeBytes
  return Math.min(chunkSizeBytes, fileSizeBytes - start)
}

export function isV3ContentRootHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function decodeV3ContentRootHex(value: string): Buffer {
  if (!isV3ContentRootHex(value)) {
    throw new TypeError('V3 content-root digests must be 64 lowercase hexadecimal characters.')
  }
  return Buffer.from(value, 'hex')
}

/**
 * Calculates the V3 content root from raw 32-byte SHA-256 chunk digests.
 * Chunks must be supplied once, in ascending contiguous index order.
 */
export function calculateV3ContentRoot(input: V3ContentRootInput): string {
  const chunkCount = getV3ContentRootChunkCount(input.fileSizeBytes, input.chunkSizeBytes)
  if (input.chunks.length !== chunkCount) {
    throw new RangeError('V3 content root chunk count does not match the file size.')
  }

  const rootHasher = createHash('sha256')
  rootHasher.update(V3_ROOT_PREFIX)
  rootHasher.update(encodeU64(input.fileSizeBytes))
  rootHasher.update(encodeU32(input.chunkSizeBytes))

  for (const [position, chunk] of input.chunks.entries()) {
    if (chunk.index !== position) {
      throw new RangeError('V3 content root chunks must be in ascending contiguous index order.')
    }
    const expectedLength = getV3ContentRootChunkLength(input.fileSizeBytes, input.chunkSizeBytes, chunk.index)
    if (chunk.length !== expectedLength) {
      throw new RangeError('V3 content root chunk length does not match its file position.')
    }
    const digest = Buffer.from(chunk.sha256)
    if (digest.length !== V3_CONTENT_ROOT_DIGEST_BYTES) {
      throw new RangeError('V3 content root chunk digests must be 32 bytes.')
    }

    const leafHasher = createHash('sha256')
    leafHasher.update(V3_LEAF_PREFIX)
    leafHasher.update(encodeU64(chunk.index))
    leafHasher.update(encodeU64(chunk.length))
    leafHasher.update(digest)
    rootHasher.update(leafHasher.digest())
  }

  return rootHasher.digest('hex')
}

export function calculateV3ContentRootFromHexDigests(input: V3ContentRootHexInput): string {
  return calculateV3ContentRoot({
    chunkSizeBytes: input.chunkSizeBytes,
    chunks: input.chunks.map((chunk) => ({
      index: chunk.index,
      length: chunk.length,
      sha256: decodeV3ContentRootHex(chunk.sha256)
    })),
    fileSizeBytes: input.fileSizeBytes
  })
}

function encodeU64(value: number): Buffer {
  assertFileSize(value)
  const encoded = Buffer.allocUnsafe(8)
  encoded.writeBigUInt64BE(BigInt(value))
  return encoded
}

function encodeU32(value: number): Buffer {
  assertChunkSize(value)
  const encoded = Buffer.allocUnsafe(4)
  encoded.writeUInt32BE(value)
  return encoded
}

function assertFileSize(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('V3 content root sizes must be non-negative safe integers.')
  }
}

function assertChunkSize(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError('V3 content root chunk size must fit in an unsigned 32-bit integer.')
  }
}
