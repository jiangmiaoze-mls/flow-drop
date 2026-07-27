import {Worker} from 'node:worker_threads'

import {
  getV3ContentVerificationWorkerPath,
  V3_CONTENT_VERIFICATION_WORKER_TYPE,
  type V3ContentVerificationProgress,
  type V3ContentVerificationRequest,
  type V3ContentVerificationResult,
  type V3ContentVerificationWorkerMessage
} from './v3ContentVerificationWorker'

export type V3ContentVerificationProgressCallback = (progress: V3ContentVerificationProgress) => void

export class V3ContentVerificationAbortedError extends Error {
  constructor() {
    super('V3 content verification was cancelled.')
    this.name = 'V3ContentVerificationAbortedError'
  }
}

/**
 * Runs one content verification in an isolated worker. The Agent main thread
 * only forwards typed messages; it never opens staging files or hashes data.
 */
export class V3ContentVerifier {
  verify(
    request: Omit<V3ContentVerificationRequest, 'requestId' | 'type'>,
    onProgress?: V3ContentVerificationProgressCallback,
    signal?: AbortSignal
  ): Promise<V3ContentVerificationResult> {
    const requestId = 1
    const worker = new Worker(getV3ContentVerificationWorkerPath(), {
      workerData: {type: V3_CONTENT_VERIFICATION_WORKER_TYPE}
    })

    return new Promise<V3ContentVerificationResult>((resolve, reject) => {
      let settled = false
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        void worker.terminate().catch(() => undefined).finally(callback)
      }
      const abort = () => settle(() => reject(new V3ContentVerificationAbortedError()))

      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, {once: true})

      worker.on('message', (message: unknown) => {
        if (!isWorkerMessage(message) || message.requestId !== requestId) return
        if (message.type === 'fatal-error') {
          settle(() => reject(new Error(message.message)))
          return
        }
        if (message.type === 'progress') {
          try {
            onProgress?.(message)
          } catch (error) {
            settle(() => reject(toError(error, 'V3 content verification progress callback failed.')))
          }
          return
        }
        settle(() => resolve(message))
      })
      worker.once('error', (error) => settle(() => reject(error)))
      worker.once('exit', (code) => {
        if (!settled) {
          settle(() => reject(new Error(`V3 content verification worker stopped with exit code ${code}.`)))
        }
      })
      try {
        worker.postMessage({...request, requestId, type: 'verify'} satisfies V3ContentVerificationRequest)
      } catch (error) {
        settle(() => reject(toError(error, 'Unable to start V3 content verification.')))
      }
    })
  }
}

function isWorkerMessage(value: unknown): value is V3ContentVerificationWorkerMessage {
  if (!isRecord(value) || typeof value.requestId !== 'number' || typeof value.type !== 'string') return false
  return value.type === 'progress' || value.type === 'result' || value.type === 'fatal-error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage)
}
