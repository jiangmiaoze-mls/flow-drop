import {randomBytes} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'

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

export class TrustedDeviceStore {
  private readonly database: DatabaseSync

  constructor(databasePath = getDefaultDatabasePath()) {
    mkdirSync(path.dirname(databasePath), {recursive: true})
    this.database = new DatabaseSync(databasePath)
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        device_kind TEXT NOT NULL,
        control_port INTEGER,
        last_known_address TEXT,
        last_seen_at INTEGER,
        paired_at INTEGER NOT NULL,
        receive_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfer_credentials (
        device_id TEXT PRIMARY KEY,
        secret TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const columns = this.database.prepare('PRAGMA table_info(trusted_devices)').all() as Array<{name: string}>
    if (!columns.some((column) => column.name === 'receive_enabled')) {
      this.database.exec('ALTER TABLE trusted_devices ADD COLUMN receive_enabled INTEGER NOT NULL DEFAULT 1')
    }
  }

  close() {
    this.database.close()
  }

  delete(deviceId: string) {
    this.database.prepare('DELETE FROM trusted_devices WHERE device_id = ?').run(deviceId)
    this.database.prepare('DELETE FROM transfer_credentials WHERE device_id = ?').run(deviceId)
  }

  get(deviceId: string): TrustedDevice | null {
    const row = this.database
      .prepare('SELECT * FROM trusted_devices WHERE device_id = ?')
      .get(deviceId) as TrustedDeviceRow | undefined
    return row ? toTrustedDevice(row) : null
  }

  list(): TrustedDevice[] {
    const rows = this.database
      .prepare('SELECT * FROM trusted_devices ORDER BY device_name COLLATE NOCASE')
      .all() as TrustedDeviceRow[]
    return rows.map(toTrustedDevice)
  }

  setReceiveEnabled(deviceId: string, receiveEnabled: boolean): TrustedDevice | null {
    const now = Date.now()
    this.database
      .prepare('UPDATE trusted_devices SET receive_enabled = ?, updated_at = ? WHERE device_id = ?')
      .run(receiveEnabled ? 1 : 0, now, deviceId)
    return this.get(deviceId)
  }

  createTransferSecret(deviceId: string): string {
    const secret = randomBytes(32).toString('hex')
    this.setTransferSecret(deviceId, secret)
    return secret
  }

  setTransferSecret(deviceId: string, secret: string) {
    if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('Invalid transfer credential.')
    this.database.prepare(`
      INSERT INTO transfer_credentials (device_id, secret, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at
    `).run(deviceId, secret, Date.now())
  }

  getTransferSecret(deviceId: string): string | null {
    const row = this.database.prepare('SELECT secret FROM transfer_credentials WHERE device_id = ?')
      .get(deviceId) as {secret: string} | undefined
    return row?.secret ?? null
  }

  upsert(device: TrustedDevice): TrustedDevice {
    this.database.prepare(`
      INSERT INTO trusted_devices (
        device_id, device_name, device_kind, control_port, last_known_address,
        last_seen_at, paired_at, receive_enabled, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(device_id) DO UPDATE SET
        device_name = excluded.device_name,
        device_kind = excluded.device_kind,
        control_port = excluded.control_port,
        last_known_address = excluded.last_known_address,
        last_seen_at = excluded.last_seen_at,
        receive_enabled = excluded.receive_enabled,
        updated_at = excluded.updated_at
    `).run(
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

    return this.get(device.deviceId) ?? device
  }
}

function getDefaultDatabasePath() {
  const dataDirectory = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(dataDirectory, 'FlowDrop', 'flowdrop.sqlite')
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
