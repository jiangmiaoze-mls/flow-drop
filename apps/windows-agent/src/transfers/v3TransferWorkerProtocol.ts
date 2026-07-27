import type {
  V3AdminTransferSnapshot,
  V3ChunkAck,
  V3ChunkDigestPage,
  V3CompletionFile,
  V3CreateTransferResponse,
  V3TransferControlResponse,
  V3TransferStatusSnapshot,
  V3TransferStatus
} from './v3TransportTypes'

export type V3TransferCreation = {
  chunkSizeBytes: number
  items: Array<{
    itemId: string
    mimeType: string
    name: string
    sizeBytes: number
  }>
  sourceDeviceId: string
  transferId: string
}

export type V3ChunkWriteTarget = {
  chunkSizeBytes: number
  itemSizeBytes: number
  sourceDeviceId: string
  status: V3TransferStatus
}

export type V3ChunkMetadata = {
  chunkIndex: number
  itemId: string
  jobId: number
  sha256: string
  sizeBytes: number
}

export type V3SerializedTransferError = {
  code: string
  message: string
  statusCode: number
}

export type V3ChunkPreflightResult = {
  error?: V3SerializedTransferError
  jobId: number
  state: 'duplicate' | 'new'
}

export type V3ChunkBatchCommitResult = {
  acknowledgements: Array<{ack: V3ChunkAck; jobId: number}>
  committed: boolean
}

export type V3CompletionVerificationPlan = {
  chunkSizeBytes: number
  completionAttempt: number
  items: Array<{
    itemId: string
    sizeBytes: number
  }>
  transferId: string
}

export type V3CompletionBeginResult = {
  completionAttempt: number
  disposition: 'accepted' | 'already-completed' | 'already-completing' | 'failed' | 'retrying'
  snapshot: V3TransferStatusSnapshot
  verificationPlan?: V3CompletionVerificationPlan
}

export type V3CompletionMutationResult = {
  applied: boolean
  snapshot: V3TransferStatusSnapshot
}

export type V3TransferWorkerRequest = {
  id: number
  payload:
    | {creation: V3TransferCreation; type: 'createOrGet'}
    | {itemId: string; transferId: string; type: 'getChunkWriteTarget'}
    | {chunkIndex: number; itemId: string; transferId: string; type: 'getChunkAck'}
    | {chunks: V3ChunkMetadata[]; sourceDeviceId: string; transferId: string; type: 'preflightChunkBatch'}
    | {
      acknowledgementChunks: V3ChunkMetadata[]
      newChunks: V3ChunkMetadata[]
      sourceDeviceId: string
      transferId: string
      type: 'commitChunkBatch'
    }
    | {files: V3CompletionFile[]; sourceDeviceId: string; transferId: string; type: 'beginCompletion'}
    | {sourceDeviceId: string; transferId: string; type: 'pauseTransfer'}
    | {sourceDeviceId: string; transferId: string; type: 'resumeTransfer'}
    | {sourceDeviceId: string; transferId: string; type: 'cancelTransfer'}
    | {sourceDeviceId: string; transferId: string; type: 'getStatus'}
    | {
      itemId: string
      limit: number
      offset: number
      sourceDeviceId: string
      transferId: string
      type: 'getChunkDigests'
    }
    | {
      completionAttempt: number
      transferId: string
      type: 'getCompletionVerificationPlan'
    }
    | {
      completionAttempt: number
      transferId: string
      type: 'setVerificationProgress'
      verifyingBytes: number
      verifyingPhase: 'idle' | 'reading' | 'hashing' | 'done'
      verifyingTotalBytes: number
    }
    | {
      actualFiles: V3CompletionFile[]
      completionAttempt: number
      transferId: string
      type: 'markTransferCompleted'
    }
    | {
      completionAttempt: number
      errorCode: 'PART_CONTENT_ROOT_MISMATCH' | 'PART_READ_ERROR'
      transferId: string
      type: 'markTransferFailed'
      verifyingBytes: number
      verifyingPhase: 'idle' | 'reading' | 'hashing' | 'done'
      verifyingTotalBytes: number
    }
    | {type: 'listCancelledTransferIds'}
    | {type: 'listForAdmin'}
    | {type: 'close'}
}

export type V3TransferWorkerSuccessResult =
  | {created: boolean; response: V3CreateTransferResponse}
  | V3ChunkWriteTarget
  | V3ChunkAck
  | V3ChunkPreflightResult[]
  | V3ChunkBatchCommitResult
  | V3CompletionBeginResult
  | V3CompletionMutationResult
  | V3CompletionVerificationPlan
  | V3TransferControlResponse
  | V3TransferStatusSnapshot
  | V3ChunkDigestPage
  | string[]
  | V3AdminTransferSnapshot[]
  | null

export type V3TransferWorkerResponse = {
  error?: V3SerializedTransferError
  id: number
  result?: V3TransferWorkerSuccessResult
}
