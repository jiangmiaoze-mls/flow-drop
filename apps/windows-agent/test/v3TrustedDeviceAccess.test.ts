import assert from 'node:assert/strict'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {TrustedDeviceStore} from '../src/storage/trustedDeviceStore'
import {
  V3TrustedDeviceAccessBackpressureError,
  V3TrustedDeviceAccessClient,
  V3TrustedDeviceAccessTimeoutError
} from '../src/transfers/v3TrustedDeviceAccess'

test('bounds outstanding asynchronous trusted-device requests even when the worker stops responding', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-trusted-access-bound-'))
  const trustedDeviceStore = new TrustedDeviceStore(path.join(root, 'trusted-devices.sqlite'))
  const access = new V3TrustedDeviceAccessClient(trustedDeviceStore.databasePath, {
    maxOutstandingRequests: 2,
    requestTimeoutMs: 50
  })
  try {
    const worker = (access as unknown as {worker: {postMessage: (message: unknown) => void}}).worker
    worker.postMessage = () => undefined

    const first = access.get('device-001')
    const second = access.get('device-002')
    await assert.rejects(
      access.get('device-003'),
      (error: unknown) => error instanceof V3TrustedDeviceAccessBackpressureError
    )
    await assert.rejects(first, (error: unknown) => error instanceof V3TrustedDeviceAccessTimeoutError)
    await assert.rejects(second, (error: unknown) => error instanceof V3TrustedDeviceAccessTimeoutError)
    await assert.rejects(
      access.get('device-004'),
      (error: unknown) => error instanceof V3TrustedDeviceAccessBackpressureError
    )
  } finally {
    await access.close()
    trustedDeviceStore.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})

test('opens the trusted-device worker database read-only and does not create a missing database', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowdrop-v3-trusted-access-readonly-'))
  const databasePath = path.join(root, 'missing-trusted-devices.sqlite')
  const access = new V3TrustedDeviceAccessClient(databasePath, {requestTimeoutMs: 500})
  try {
    await assert.rejects(access.get('device-001'))
    assert.equal(existsSync(databasePath), false)
  } finally {
    await access.close()
    rmSync(root, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
})
