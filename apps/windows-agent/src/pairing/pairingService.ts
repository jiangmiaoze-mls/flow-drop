import {randomInt, randomUUID} from 'node:crypto'

import type {
  DeviceKind,
  PairingApprovalRequest,
  PairingApprovalStatus,
  PairingSession,
  PairingVerificationRequest,
  TrustedDevice
} from '@flowdrop/types'

import {TrustedDeviceStore} from '../storage/trustedDeviceStore'


const MAX_FAILED_ATTEMPTS = 5
const PAIRING_APPROVAL_TTL_MS = 60_000
const PAIRING_OUTCOME_TTL_MS = 60_000
const PAIRING_SESSION_TTL_MS = 2 * 60 * 1000

export type PairingApprovalSubmissionResult =
  | {status: 'invalid'}
  | {status: 'pending'; request: PairingApprovalRequest}

export type PairingApprovalResolution = {
  request: PairingApprovalRequest
  requesterConnectionId?: string
  status: Exclude<PairingApprovalStatus, 'pending'>
  transferSecret?: string
  trustedDevice?: TrustedDevice
}

type PendingPairingApproval = PairingApprovalRequest & {
  address: string
  requesterConnectionId?: string
}

type PairingApprovalOutcome = {
  expiresAt: number
  status: Exclude<PairingApprovalStatus, 'pending'>
}

export class PairingService {
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly outcomes = new Map<string, PairingApprovalOutcome>()
  private readonly pendingApprovals = new Map<string, PendingPairingApproval>()
  private readonly resolutionListeners = new Set<(resolution: PairingApprovalResolution) => void>()
  private readonly sessions = new Map<string, PairingSession>()

  constructor(private readonly trustedDeviceStore: TrustedDeviceStore) {}

  close() {
    for (const expiryTimer of this.expiryTimers.values()) clearTimeout(expiryTimer)
    this.expiryTimers.clear()
    this.outcomes.clear()
    this.pendingApprovals.clear()
    this.resolutionListeners.clear()
    this.sessions.clear()
  }

  createSession(): PairingSession {
    this.removeExpiredRecords()

    let code: string
    do {
      code = randomInt(0, 1_000_000).toString().padStart(6, '0')
    } while ([...this.sessions.values()].some((session) => session.code === code))

    const now = Date.now()
    const session: PairingSession = {
      code,
      createdAt: now,
      expiresAt: now + PAIRING_SESSION_TTL_MS,
      failedAttempts: 0,
      sessionId: randomUUID()
    }
    this.sessions.set(session.sessionId, session)
    return session
  }

  approvePairingRequest(requestId: string): PairingApprovalResolution | null {
    this.removeExpiredRecords()
    const pendingApproval = this.pendingApprovals.get(requestId)
    if (!pendingApproval) return null

    const now = Date.now()
    const existingDevice = this.trustedDeviceStore.get(pendingApproval.deviceId)
    const trustedDevice = this.trustedDeviceStore.upsert({
      deviceId: pendingApproval.deviceId,
      deviceKind: pendingApproval.deviceKind,
      deviceName: pendingApproval.deviceName,
      lastKnownAddress: pendingApproval.address,
      lastSeenAt: now,
      pairedAt: existingDevice?.pairedAt ?? now,
      receiveEnabled: existingDevice?.receiveEnabled ?? true,
      updatedAt: now
    })
    const transferSecret = this.trustedDeviceStore.createTransferSecret(pendingApproval.deviceId)
    return this.completePairingRequest(pendingApproval, 'approved', trustedDevice, transferSecret)
  }

  getPairingRequestStatus(requestId: string): PairingApprovalStatus | null {
    this.removeExpiredRecords()
    if (this.pendingApprovals.has(requestId)) return 'pending'
    return this.outcomes.get(requestId)?.status ?? null
  }

  getPendingPairingRequests(): PairingApprovalRequest[] {
    this.removeExpiredRecords()
    return [...this.pendingApprovals.values()]
      .map(toPairingApprovalRequest)
      .sort((left, right) => left.requestedAt - right.requestedAt)
  }

  rejectPairingRequest(requestId: string): PairingApprovalResolution | null {
    this.removeExpiredRecords()
    const pendingApproval = this.pendingApprovals.get(requestId)
    if (!pendingApproval) return null

    return this.completePairingRequest(pendingApproval, 'rejected')
  }

  requestPairingApproval(
    request: PairingVerificationRequest,
    address: string,
    options: {requestId?: string; requesterConnectionId?: string} = {}
  ): PairingApprovalSubmissionResult {
    this.removeExpiredRecords()
    const existingPendingApproval = options.requestId ? this.pendingApprovals.get(options.requestId) : undefined
    if (existingPendingApproval?.deviceId === request.deviceId) {
      return {status: 'pending', request: toPairingApprovalRequest(existingPendingApproval)}
    }

    const session = [...this.sessions.values()].find((candidate) => candidate.code === request.code)
    if (!session) return {status: 'invalid'}

    if (session.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      this.sessions.delete(session.sessionId)
      return {status: 'invalid'}
    }

    if (!isPairingRequest(request)) {
      session.failedAttempts += 1
      if (session.failedAttempts >= MAX_FAILED_ATTEMPTS) this.sessions.delete(session.sessionId)
      return {status: 'invalid'}
    }

    this.sessions.delete(session.sessionId)
    const pendingApproval: PendingPairingApproval = {
      address,
      deviceId: request.deviceId,
      deviceKind: request.deviceKind,
      deviceName: request.deviceName,
      requestId: options.requestId ?? randomUUID(),
      requestedAt: Date.now(),
      requesterConnectionId: options.requesterConnectionId
    }
    this.pendingApprovals.set(pendingApproval.requestId, pendingApproval)
    this.expiryTimers.set(pendingApproval.requestId, setTimeout(() => {
      const pendingRequest = this.pendingApprovals.get(pendingApproval.requestId)
      if (pendingRequest) this.completePairingRequest(pendingRequest, 'expired')
    }, PAIRING_APPROVAL_TTL_MS))
    return {status: 'pending', request: toPairingApprovalRequest(pendingApproval)}
  }

  rebindPairingRequestConnection(requestId: string, deviceId: string, connectionId: string): boolean {
    this.removeExpiredRecords()
    const pendingApproval = this.pendingApprovals.get(requestId)
    if (!pendingApproval || pendingApproval.deviceId !== deviceId) return false

    pendingApproval.requesterConnectionId = connectionId
    return true
  }

  subscribeToResolutions(listener: (resolution: PairingApprovalResolution) => void): () => void {
    this.resolutionListeners.add(listener)
    return () => this.resolutionListeners.delete(listener)
  }

  private completePairingRequest(
    pendingApproval: PendingPairingApproval,
    status: Exclude<PairingApprovalStatus, 'pending'>,
    trustedDevice?: TrustedDevice,
    transferSecret?: string
  ): PairingApprovalResolution {
    this.pendingApprovals.delete(pendingApproval.requestId)
    const expiryTimer = this.expiryTimers.get(pendingApproval.requestId)
    if (expiryTimer) clearTimeout(expiryTimer)
    this.expiryTimers.delete(pendingApproval.requestId)
    this.outcomes.set(pendingApproval.requestId, {
      expiresAt: Date.now() + PAIRING_OUTCOME_TTL_MS,
      status
    })
    const resolution: PairingApprovalResolution = {
      request: toPairingApprovalRequest(pendingApproval),
      requesterConnectionId: pendingApproval.requesterConnectionId,
      status,
      transferSecret,
      trustedDevice
    }
    for (const listener of this.resolutionListeners) listener(resolution)
    return resolution
  }

  private removeExpiredRecords() {
    const now = Date.now()
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId)
    }
    for (const pendingApproval of [...this.pendingApprovals.values()]) {
      if (pendingApproval.requestedAt + PAIRING_APPROVAL_TTL_MS <= now) {
        this.completePairingRequest(pendingApproval, 'expired')
      }
    }
    for (const [requestId, outcome] of this.outcomes) {
      if (outcome.expiresAt <= now) this.outcomes.delete(requestId)
    }
  }
}

function toPairingApprovalRequest(value: PendingPairingApproval): PairingApprovalRequest {
  return {
    deviceId: value.deviceId,
    deviceKind: value.deviceKind,
    deviceName: value.deviceName,
    requestId: value.requestId,
    requestedAt: value.requestedAt
  }
}

function isPairingRequest(value: PairingVerificationRequest): boolean {
  return (
    /^\d{6}$/.test(value.code) &&
    typeof value.deviceId === 'string' && value.deviceId.length > 0 && value.deviceId.length <= 128 &&
    typeof value.deviceName === 'string' && value.deviceName.trim().length > 0 && value.deviceName.length <= 128 &&
    isDeviceKind(value.deviceKind)
  )
}

function isDeviceKind(value: unknown): value is DeviceKind {
  return value === 'desktop' || value === 'laptop' || value === 'mobile'
}
