import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import test from 'node:test'

import {v3InitialMigration} from '../src/transfers/migrations/001_v3_initial'
import {migrateV3TransferDatabase} from '../src/transfers/v3Migration'

test('preserves 001 item insertion order when 002 backfills item ordinals', () => {
  const database = new DatabaseSync(':memory:')
  try {
    v3InitialMigration.up(database)
    database.exec(`
      CREATE TABLE v3_transfer_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO v3_transfer_schema_migrations (id, applied_at) VALUES ('001_v3_initial', 0);
    `)
    database.prepare(`
      INSERT INTO v3_transfers (
        transfer_id, source_device_id, chunk_size_bytes, status, revision,
        received_bytes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('transfer-migration-order', 'device-migration-order', 1048576, 'transferring', 0, 0, 0, 0)
    const insertItem = database.prepare(`
      INSERT INTO v3_transfer_items (
        transfer_id, item_id, name, mime_type, size_bytes, received_bytes
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    insertItem.run('transfer-migration-order', 'item-zulu', 'first.bin', 'application/octet-stream', 0, 0)
    insertItem.run('transfer-migration-order', 'item-alpha', 'second.bin', 'application/octet-stream', 0, 0)
    insertItem.run('transfer-migration-order', 'item-mike', 'third.bin', 'application/octet-stream', 0, 0)

    migrateV3TransferDatabase(database)

    const items = database.prepare(`
      SELECT item_id, item_ordinal
      FROM v3_transfer_items
      WHERE transfer_id = ?
      ORDER BY item_ordinal
    `).all('transfer-migration-order') as Array<{item_id: string; item_ordinal: number}>
    assert.deepEqual(items.map(({item_id, item_ordinal}) => ({item_id, item_ordinal})), [
      {item_id: 'item-zulu', item_ordinal: 0},
      {item_id: 'item-alpha', item_ordinal: 1},
      {item_id: 'item-mike', item_ordinal: 2}
    ])
  } finally {
    database.close()
  }
})
