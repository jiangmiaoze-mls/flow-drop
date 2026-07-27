export const V3_TRANSFER_SSE_DEBOUNCE_MS = 250

export type V3TransferSseDebouncerEvent = {
  revision: number
  transferId: string
}

export type V3TransferSseDebouncerClock = {
  now: () => number
}

export type V3TransferSseDebouncerTimer = {
  clearTimeout: (handle: unknown) => void
  setTimeout: (callback: () => void, delayMs: number) => unknown
}

export type V3TransferSseDebouncerOptions = {
  clock?: V3TransferSseDebouncerClock
  timer?: V3TransferSseDebouncerTimer
}

type TransferState = {
  highestRevision: number
  lastEmittedAt: number | null
  pendingRevision: number | null
  timerGeneration: number
  timerHandle: unknown | null
}

const systemClock: V3TransferSseDebouncerClock = {now: () => Date.now()}

const systemTimer: V3TransferSseDebouncerTimer = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs)
}

export class V3TransferSseDebouncer {
  private readonly clock: V3TransferSseDebouncerClock
  private closed = false
  // Timer state may be reclaimed after a quiet window, but revision history
  // must outlive that timer state so a delayed snapshot cannot move clients
  // backward after a transfer becomes quiet.
  private readonly highWaterRevisions = new Map<string, number>()
  private readonly states = new Map<string, TransferState>()
  private readonly timer: V3TransferSseDebouncerTimer

  constructor(
    private readonly emit: (event: V3TransferSseDebouncerEvent) => void,
    options: V3TransferSseDebouncerOptions = {}
  ) {
    this.clock = options.clock ?? systemClock
    this.timer = options.timer ?? systemTimer
  }

  notify(event: V3TransferSseDebouncerEvent) {
    if (this.closed) return
    assertEvent(event)

    const highestRevision = this.highWaterRevisions.get(event.transferId) ?? -1
    if (event.revision <= highestRevision) return
    this.highWaterRevisions.set(event.transferId, event.revision)

    const state = this.states.get(event.transferId) ?? this.createState(event.transferId)
    state.highestRevision = event.revision

    const now = this.clock.now()
    if (state.lastEmittedAt === null || now - state.lastEmittedAt >= V3_TRANSFER_SSE_DEBOUNCE_MS) {
      this.cancelTimer(state)
      state.pendingRevision = null
      this.emitRevision(event.transferId, state, event.revision, now)
      return
    }

    state.pendingRevision = event.revision
    this.schedule(event.transferId, state, V3_TRANSFER_SSE_DEBOUNCE_MS - (now - state.lastEmittedAt))
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const state of this.states.values()) {
      if (state.timerHandle !== null) this.timer.clearTimeout(state.timerHandle)
    }
    this.states.clear()
    this.highWaterRevisions.clear()
  }

  private createState(transferId: string): TransferState {
    const state: TransferState = {
      highestRevision: -1,
      lastEmittedAt: null,
      pendingRevision: null,
      timerGeneration: 0,
      timerHandle: null
    }
    this.states.set(transferId, state)
    return state
  }

  private emitRevision(transferId: string, state: TransferState, revision: number, emittedAt: number) {
    state.lastEmittedAt = emittedAt
    this.emit({revision, transferId})
    if (this.closed) return
    this.schedule(transferId, state, V3_TRANSFER_SSE_DEBOUNCE_MS)
  }

  private cancelTimer(state: TransferState) {
    if (state.timerHandle !== null) this.timer.clearTimeout(state.timerHandle)
    state.timerHandle = null
    state.timerGeneration += 1
  }

  private schedule(transferId: string, state: TransferState, delayMs: number) {
    if (this.closed) return
    if (state.timerHandle !== null) return
    const generation = ++state.timerGeneration
    state.timerHandle = this.timer.setTimeout(() => this.onTimer(transferId, state, generation), Math.max(0, delayMs))
  }

  private onTimer(transferId: string, state: TransferState, generation: number) {
    if (this.closed || state.timerGeneration !== generation) return
    state.timerHandle = null
    const revision = state.pendingRevision
    if (revision === null) {
      if (this.states.get(transferId) === state) this.states.delete(transferId)
      return
    }

    const now = this.clock.now()
    const lastEmittedAt = state.lastEmittedAt
    if (lastEmittedAt === null) return
    const remaining = V3_TRANSFER_SSE_DEBOUNCE_MS - (now - lastEmittedAt)
    if (remaining > 0) {
      this.schedule(transferId, state, remaining)
      return
    }

    state.pendingRevision = null
    this.emitRevision(transferId, state, revision, now)
  }
}

function assertEvent(event: V3TransferSseDebouncerEvent) {
  if (typeof event.transferId !== 'string' || event.transferId.length === 0) {
    throw new TypeError('A transfer ID is required for SSE debouncing.')
  }
  if (!Number.isSafeInteger(event.revision) || event.revision < 0) {
    throw new TypeError('An SSE revision must be a non-negative safe integer.')
  }
}
