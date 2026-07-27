import {DatabaseSync} from 'node:sqlite'
import {parentPort, workerData} from 'node:worker_threads'

import type {V3TrustedDeviceAccessRecord} from './v3TrustedDeviceAccess'

type V3TrustedDeviceAccessWorkerData = {
  databasePath: string
}

type V3TrustedDeviceAccessWorkerRequest = {
  deviceId: string
  id: number
  type: 'get'
}

type TrustedDeviceAccessRow = {
  receive_enabled: number
  secret: string | null
}

const databasePath = getDatabasePath(workerData)
const database = new DatabaseSync(databasePath, {readOnly: true})
database.exec('PRAGMA busy_timeout = 100')
database.exec('PRAGMA query_only = ON')

const getTrustedDevice = database.prepare(`
  SELECT devices.receive_enabled, credentials.secret
  FROM trusted_devices AS devices
  LEFT JOIN transfer_credentials AS credentials ON credentials.device_id = devices.device_id
  WHERE devices.device_id = ?
`)

const port = parentPort
if (!port) throw new Error('V3 trusted-device access worker has no parent port.')

port.on('message', (message: unknown) => {
  if (!isWorkerRequest(message)) return
  try {
    const row = getTrustedDevice.get(message.deviceId) as TrustedDeviceAccessRow | undefined
    const result: V3TrustedDeviceAccessRecord | null = row
      ? {receiveEnabled: row.receive_enabled === 1, transferSecret: row.secret}
      : null
    port.postMessage({id: message.id, result})
  } catch (error) {
    port.postMessage({error: toErrorMessage(error), id: message.id})
  }
})

function getDatabasePath(value: unknown): string {
  if (!isRecord(value) || typeof value.databasePath !== 'string' || value.databasePath.length === 0) {
    throw new Error('V3 trusted-device access worker requires a database path.')
  }
  return value.databasePath
}

function isWorkerRequest(value: unknown): value is V3TrustedDeviceAccessWorkerRequest {
  return isRecord(value)
    && value.type === 'get'
    && typeof value.id === 'number'
    && Number.isSafeInteger(value.id)
    && typeof value.deviceId === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : 'V3 trusted-device access worker failed.'
}
