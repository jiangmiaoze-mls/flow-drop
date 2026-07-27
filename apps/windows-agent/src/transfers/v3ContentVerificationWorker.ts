import {createHash} from 'node:crypto'
import {open} from 'node:fs/promises'
import type {FileHandle} from 'node:fs/promises'
import path from 'node:path'
import {parentPort, workerData} from 'node:worker_threads'

import {
  calculateV3ContentRoot,
  getV3ContentRootChunkCount,
  getV3ContentRootChunkLength,
  type V3ContentRootDigestChunk
} from './v3ContentRoot'

export const V3_CONTENT_VERIFICATION_PROGRESS_INTERVAL_MS = 250
export const V3_CONTENT_VERIFICATION_WORKER_TYPE = 'flowdrop-v3-content-verification'

export type V3ContentVerificationPhase = 'done' | 'hashing' | 'reading'

export type V3ContentVerificationItem = {
  itemId: string
  sizeBytes: number
}

export type V3ContentVerificationRequest = {
  chunkSizeBytes: number
  expectedItems: readonly V3ContentVerificationItem[]
  requestId: number
  stagingDirectory: string
  transferId: string
  type: 'verify'
}

export type V3ContentVerificationProgress = {
  requestId: number
  type: 'progress'
  verifyingBytes: number
  verifyingPhase: V3ContentVerificationPhase
  verifyingTotalBytes: number
}

export type V3ContentVerificationItemResult = {
  actualContentRoot: string
  itemId: string
} | {
  error: {
    code: 'PART_CONTENT_ROOT_MISMATCH' | 'PART_READ_ERROR'
    message: string
  }
  itemId: string
}

type V3PartVerificationErrorCode = 'PART_CONTENT_ROOT_MISMATCH' | 'PART_READ_ERROR'

export type V3ContentVerificationResult = {
  items: V3ContentVerificationItemResult[]
  requestId: number
  type: 'result'
}

export type V3ContentVerificationFatalError = {
  message: string
  requestId: number
  type: 'fatal-error'
}

export type V3ContentVerificationWorkerMessage =
  | V3ContentVerificationProgress
  | V3ContentVerificationResult
  | V3ContentVerificationFatalError

export type V3ContentVerificationWorkerData = {
  type: typeof V3_CONTENT_VERIFICATION_WORKER_TYPE
}

export function getV3ContentVerificationWorkerPath() {
  return __filename.endsWith('.ts')
    ? path.resolve(__dirname, '../../dist/transfers/v3ContentVerificationWorker.js')
    : path.join(__dirname, 'v3ContentVerificationWorker.js')
}

const port = parentPort
if (port && isContentVerificationWorkerData(workerData)) {
  let current = Promise.resolve()
  port.on('message', (message: unknown) => {
    if (!isVerificationRequest(message)) return
    current = current
      .then(() => verifyAndPublish(message, port))
      .catch(() => undefined)
  })
}

async function verifyAndPublish(request: V3ContentVerificationRequest, port: NonNullable<typeof parentPort>) {
  const fallbackRequestId = Number.isSafeInteger(request.requestId) && request.requestId >= 0 ? request.requestId : 0
  let progress: V3VerificationProgressReporter | null = null
  let verifyingBytes = 0

  try {
    validateRequest(request)
    const verifyingTotalBytes = getVerifyingTotalBytes(request.expectedItems)
    progress = new V3VerificationProgressReporter(port, request.requestId, verifyingTotalBytes)
    progress.publish('reading', verifyingBytes, true)
    const stagedChunks = new Map<string, V3ContentRootDigestChunk[]>()
    const itemErrors = new Map<string, V3PartVerificationErrorCode>()

    for (const item of request.expectedItems) {
      const chunks: V3ContentRootDigestChunk[] = []
      stagedChunks.set(item.itemId, chunks)
      if (item.sizeBytes === 0) {
        try {
          await assertZeroByteStagingFile(request.stagingDirectory, request.transferId, item.itemId)
        } catch (error) {
          itemErrors.set(item.itemId, getPartVerificationErrorCode(error))
        }
        continue
      }

      let handle: FileHandle | null = null
      try {
        const stagingPath = getStagingPath(request.stagingDirectory, request.transferId, item.itemId)
        handle = await open(stagingPath, 'r')
        const stats = await handle.stat()
        if (!stats.isFile() || stats.size !== item.sizeBytes) {
          throw new V3PartContentMismatchError('Staged V3 item size does not match the durable item size.')
        }

        const chunkCount = getV3ContentRootChunkCount(item.sizeBytes, request.chunkSizeBytes)
        for (let index = 0; index < chunkCount; index += 1) {
          const length = getV3ContentRootChunkLength(item.sizeBytes, request.chunkSizeBytes, index)
          const data = Buffer.allocUnsafe(length)
          const readBytes = await readFully(handle, data, index * request.chunkSizeBytes, (bytesRead) => {
            verifyingBytes += bytesRead
            progress?.publish('reading', verifyingBytes)
          })
          if (readBytes !== length) {
            throw new V3PartContentMismatchError('Staged V3 item ended before its durable size.')
          }
          chunks.push({
            index,
            length,
            sha256: createHash('sha256').update(data).digest()
          })
        }
      } catch (error) {
        itemErrors.set(item.itemId, getPartVerificationErrorCode(error))
      } finally {
        if (handle) await closeIgnoringSecondaryError(handle)
      }
    }

    progress.publish('hashing', verifyingBytes, true)
    const items: V3ContentVerificationItemResult[] = request.expectedItems.map((item) => {
      const errorCode = itemErrors.get(item.itemId)
      if (errorCode) return toPartError(item.itemId, errorCode)
      try {
        return {
          actualContentRoot: calculateV3ContentRoot({
            chunkSizeBytes: request.chunkSizeBytes,
            chunks: stagedChunks.get(item.itemId) ?? [],
            fileSizeBytes: item.sizeBytes
          }),
          itemId: item.itemId
        }
      } catch {
        return toPartError(item.itemId, 'PART_CONTENT_ROOT_MISMATCH')
      }
    })
    progress.publish('done', verifyingBytes, true)
    port.postMessage({items, requestId: request.requestId, type: 'result'} satisfies V3ContentVerificationResult)
  } catch (error) {
    port.postMessage({
      message: error instanceof Error ? error.message : 'V3 content verification worker failed.',
      requestId: fallbackRequestId,
      type: 'fatal-error'
    } satisfies V3ContentVerificationFatalError)
  }
}

async function readFully(
  handle: FileHandle,
  data: Buffer,
  position: number,
  onRead: (bytesRead: number) => void
): Promise<number> {
  let totalRead = 0
  while (totalRead < data.length) {
    const result = await handle.read(data, totalRead, data.length - totalRead, position + totalRead)
    if (result.bytesRead <= 0) break
    totalRead += result.bytesRead
    onRead(result.bytesRead)
  }
  return totalRead
}

async function closeIgnoringSecondaryError(handle: FileHandle) {
  try {
    await handle.close()
  } catch {
    // The primary read error, if any, determines the protocol outcome.
  }
}

async function assertZeroByteStagingFile(stagingDirectory: string, transferId: string, itemId: string) {
  const stagingPath = getStagingPath(stagingDirectory, transferId, itemId)
  let handle: FileHandle | null = null
  try {
    try {
      handle = await open(stagingPath, 'r')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size !== 0) {
      throw new V3PartContentMismatchError('Staged zero-byte V3 item is not empty.')
    }
  } finally {
    if (handle) await closeIgnoringSecondaryError(handle)
  }
}

function getStagingPath(stagingDirectory: string, transferId: string, itemId: string) {
  if (!isPathSegment(transferId) || !isPathSegment(itemId)) {
    throw new TypeError('V3 content verification identifiers must be safe path segments.')
  }
  const stagingRoot = path.resolve(stagingDirectory)
  const transferDirectory = path.resolve(stagingRoot, transferId)
  const stagingPath = path.resolve(transferDirectory, `${itemId}.part`)
  if (path.dirname(stagingPath) !== transferDirectory || !isDescendant(stagingRoot, transferDirectory)) {
    throw new TypeError('V3 content verification staging path escapes its root.')
  }
  return stagingPath
}

function isDescendant(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function getVerifyingTotalBytes(items: readonly V3ContentVerificationItem[]) {
  let total = 0
  for (const item of items) {
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
      throw new TypeError('V3 content verification item sizes must be non-negative safe integers.')
    }
    total += item.sizeBytes
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('V3 content verification byte total exceeds the safe integer range.')
    }
  }
  return total
}

function toPartError(itemId: string, code: V3PartVerificationErrorCode): V3ContentVerificationItemResult {
  return {
    error: {
      code,
      message: code === 'PART_READ_ERROR'
        ? 'Unable to read staged V3 transfer content.'
        : 'Staged V3 transfer content does not match its durable boundary.'
    },
    itemId
  }
}

function validateRequest(request: V3ContentVerificationRequest) {
  if (!Number.isSafeInteger(request.requestId) || request.requestId < 0) {
    throw new TypeError('V3 content verification request id is invalid.')
  }
  if (typeof request.stagingDirectory !== 'string' || request.stagingDirectory.length === 0) {
    throw new TypeError('V3 content verification staging directory is invalid.')
  }
  if (!isPathSegment(request.transferId) || !Array.isArray(request.expectedItems)) {
    throw new TypeError('V3 content verification request is invalid.')
  }
  const itemIds = new Set<string>()
  for (const item of request.expectedItems) {
    if (!isPathSegment(item.itemId) || itemIds.has(item.itemId) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
      throw new TypeError('V3 content verification items are invalid.')
    }
    itemIds.add(item.itemId)
  }
  getV3ContentRootChunkCount(0, request.chunkSizeBytes)
}

function isPathSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isContentVerificationWorkerData(value: unknown): value is V3ContentVerificationWorkerData {
  return isRecord(value) && value.type === V3_CONTENT_VERIFICATION_WORKER_TYPE
}

function isVerificationRequest(value: unknown): value is V3ContentVerificationRequest {
  if (!isRecord(value) || value.type !== 'verify') return false
  return typeof value.requestId === 'number'
    && typeof value.transferId === 'string'
    && typeof value.stagingDirectory === 'string'
    && typeof value.chunkSizeBytes === 'number'
    && Array.isArray(value.expectedItems)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value && value.code === code
}

function getPartVerificationErrorCode(error: unknown): V3PartVerificationErrorCode {
  return error instanceof V3PartContentMismatchError ? 'PART_CONTENT_ROOT_MISMATCH' : 'PART_READ_ERROR'
}

class V3PartContentMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'V3PartContentMismatchError'
  }
}

class V3VerificationProgressReporter {
  private lastPublishedAt = Number.NEGATIVE_INFINITY
  private lastPhase: V3ContentVerificationPhase | null = null

  constructor(
    private readonly port: NonNullable<typeof parentPort>,
    private readonly requestId: number,
    private readonly verifyingTotalBytes: number
  ) {}

  publish(phase: V3ContentVerificationPhase, verifyingBytes: number, force = false) {
    const now = Date.now()
    if (!force && this.lastPhase === phase && now - this.lastPublishedAt < V3_CONTENT_VERIFICATION_PROGRESS_INTERVAL_MS) {
      return
    }
    this.lastPublishedAt = now
    this.lastPhase = phase
    this.port.postMessage({
      requestId: this.requestId,
      type: 'progress',
      verifyingBytes,
      verifyingPhase: phase,
      verifyingTotalBytes: this.verifyingTotalBytes
    } satisfies V3ContentVerificationProgress)
  }
}
