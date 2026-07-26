import * as SQLite from 'expo-sqlite'

import type {TrustedDevice} from '@flowdrop/types'


type TrustedDeviceRow = {
  control_port: number | null
  device_id: string
  device_kind: TrustedDevice['deviceKind']
  device_name: string
  last_known_address: string | null
  last_seen_at: number | null
  paired_at: number
  receive_enabled: number
  updated_at: number
}

const database = SQLite.openDatabaseSync('flowdrop.sqlite')

database.execSync(`
  CREATE TABLE IF NOT EXISTS trusted_devices (
    device_id TEXT PRIMARY KEY NOT NULL,
    device_name TEXT NOT NULL,
    device_kind TEXT NOT NULL,
    control_port INTEGER,
    last_known_address TEXT,
    last_seen_at INTEGER,
    paired_at INTEGER NOT NULL,
    receive_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )
`)

const existingColumns = database.getAllSync<{name: string}>('PRAGMA table_info(trusted_devices)')
if (!existingColumns.some((column) => column.name === 'receive_enabled')) {
  database.execSync('ALTER TABLE trusted_devices ADD COLUMN receive_enabled INTEGER NOT NULL DEFAULT 1')
}

export function deleteTrustedDevice(deviceId: string) {
  database.runSync('DELETE FROM trusted_devices WHERE device_id = ?', deviceId)
}

export function listTrustedDevices(): TrustedDevice[] {
  return database
    .getAllSync<TrustedDeviceRow>('SELECT * FROM trusted_devices ORDER BY device_name COLLATE NOCASE')
    .map(toTrustedDevice)
}

export function setTrustedDeviceReceiveEnabled(deviceId: string, receiveEnabled: boolean): TrustedDevice | null {
  const now = Date.now()
  database.runSync(
    'UPDATE trusted_devices SET receive_enabled = ?, updated_at = ? WHERE device_id = ?',
    receiveEnabled ? 1 : 0,
    now,
    deviceId
  )

  const row = database
    .getFirstSync<TrustedDeviceRow>('SELECT * FROM trusted_devices WHERE device_id = ?', deviceId)
  return row ? toTrustedDevice(row) : null
}

export function upsertTrustedDevice(device: TrustedDevice): TrustedDevice {
  database.runSync(
    `INSERT INTO trusted_devices (
      device_id, device_name, device_kind, control_port, last_known_address,
      last_seen_at, paired_at, receive_enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      device_name = excluded.device_name,
      device_kind = excluded.device_kind,
      control_port = excluded.control_port,
      last_known_address = excluded.last_known_address,
      last_seen_at = excluded.last_seen_at,
      receive_enabled = excluded.receive_enabled,
      updated_at = excluded.updated_at`,
    device.deviceId,
    device.deviceName,
    device.deviceKind,
    device.controlPort ?? null,
    device.lastKnownAddress ?? null,
    device.lastSeenAt ?? null,
    device.pairedAt,
    device.receiveEnabled ? 1 : 0,
    device.updatedAt
  )

  return device
}

function toTrustedDevice(row: TrustedDeviceRow): TrustedDevice {
  return {
    controlPort: row.control_port ?? undefined,
    deviceId: row.device_id,
    deviceKind: row.device_kind,
    deviceName: row.device_name,
    lastKnownAddress: row.last_known_address ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    pairedAt: row.paired_at,
    receiveEnabled: row.receive_enabled === 1,
    updatedAt: row.updated_at
  }
}
