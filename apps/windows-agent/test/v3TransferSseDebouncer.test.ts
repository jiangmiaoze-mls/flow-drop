import assert from 'node:assert/strict'
import test from 'node:test'

import {
  V3_TRANSFER_SSE_DEBOUNCE_MS,
  V3TransferSseDebouncer,
  type V3TransferSseDebouncerTimer
} from '../src/transfers/v3TransferSseDebouncer'

test('coalesces per-transfer SSE notifications without accepting a lower revision', () => {
  const timer = new FakeTimer()
  const emitted: Array<{revision: number; transferId: string}> = []
  const debouncer = new V3TransferSseDebouncer((event) => emitted.push(event), {
    clock: {now: () => timer.now},
    timer
  })

  debouncer.notify({revision: 0, transferId: 'transfer-a'})
  debouncer.notify({revision: 1, transferId: 'transfer-a'})
  debouncer.notify({revision: 3, transferId: 'transfer-a'})
  debouncer.notify({revision: 2, transferId: 'transfer-a'})
  debouncer.notify({revision: 0, transferId: 'transfer-b'})
  assert.deepEqual(emitted, [
    {revision: 0, transferId: 'transfer-a'},
    {revision: 0, transferId: 'transfer-b'}
  ])

  timer.advance(V3_TRANSFER_SSE_DEBOUNCE_MS - 1)
  assert.equal(emitted.length, 2)
  timer.advance(1)
  assert.deepEqual(emitted, [
    {revision: 0, transferId: 'transfer-a'},
    {revision: 0, transferId: 'transfer-b'},
    {revision: 3, transferId: 'transfer-a'}
  ])

  debouncer.notify({revision: 4, transferId: 'transfer-a'})
  debouncer.close()
  timer.advance(V3_TRANSFER_SSE_DEBOUNCE_MS)
  assert.equal(emitted.length, 3)
})

test('releases an idle transfer debounce state after its rate window', () => {
  const timer = new FakeTimer()
  const debouncer = new V3TransferSseDebouncer(() => undefined, {
    clock: {now: () => timer.now},
    timer
  })

  debouncer.notify({revision: 0, transferId: 'transfer-idle'})
  assert.equal(getStateCount(debouncer), 1)
  timer.advance(V3_TRANSFER_SSE_DEBOUNCE_MS)
  assert.equal(getStateCount(debouncer), 0)
})

test('keeps a transfer revision high-water mark after its debounce state is reclaimed', () => {
  const timer = new FakeTimer()
  const emitted: Array<{revision: number; transferId: string}> = []
  const debouncer = new V3TransferSseDebouncer((event) => emitted.push(event), {
    clock: {now: () => timer.now},
    timer
  })

  debouncer.notify({revision: 3, transferId: 'transfer-revision-high-water'})
  timer.advance(V3_TRANSFER_SSE_DEBOUNCE_MS)
  assert.equal(getStateCount(debouncer), 0)

  debouncer.notify({revision: 2, transferId: 'transfer-revision-high-water'})
  assert.deepEqual(emitted, [{revision: 3, transferId: 'transfer-revision-high-water'}])

  debouncer.notify({revision: 4, transferId: 'transfer-revision-high-water'})
  assert.deepEqual(emitted, [
    {revision: 3, transferId: 'transfer-revision-high-water'},
    {revision: 4, transferId: 'transfer-revision-high-water'}
  ])
})

class FakeTimer implements V3TransferSseDebouncerTimer {
  now = 0

  private nextId = 1
  private readonly tasks = new Map<number, {callback: () => void; dueAt: number}>()

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle)
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.tasks.set(id, {callback, dueAt: this.now + delayMs})
    return id
  }

  advance(durationMs: number) {
    const target = this.now + durationMs
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0]
      if (!next) break
      const [id, task] = next
      this.tasks.delete(id)
      this.now = task.dueAt
      task.callback()
    }
    this.now = target
  }
}

function getStateCount(debouncer: V3TransferSseDebouncer) {
  return (debouncer as unknown as {states: Map<string, unknown>}).states.size
}
