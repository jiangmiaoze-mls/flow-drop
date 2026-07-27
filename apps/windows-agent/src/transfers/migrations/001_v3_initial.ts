import type {DatabaseSync} from 'node:sqlite'

export const v3InitialMigration = {
  id: '001_v3_initial',
  up(database: DatabaseSync) {
    database.exec(`
      CREATE TABLE v3_transfers (
        transfer_id TEXT PRIMARY KEY,
        source_device_id TEXT NOT NULL,
        chunk_size_bytes INTEGER NOT NULL CHECK(chunk_size_bytes > 0),
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        received_bytes INTEGER NOT NULL DEFAULT 0 CHECK(received_bytes >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE v3_transfer_items (
        transfer_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        received_bytes INTEGER NOT NULL DEFAULT 0 CHECK(received_bytes >= 0),
        PRIMARY KEY (transfer_id, item_id),
        FOREIGN KEY (transfer_id) REFERENCES v3_transfers(transfer_id) ON DELETE CASCADE
      );

      CREATE TABLE v3_transfer_chunks (
        transfer_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        byte_length INTEGER NOT NULL CHECK(byte_length > 0),
        sha256 TEXT NOT NULL,
        PRIMARY KEY (transfer_id, item_id, chunk_index),
        FOREIGN KEY (transfer_id, item_id)
          REFERENCES v3_transfer_items(transfer_id, item_id) ON DELETE CASCADE
      );

      CREATE INDEX v3_transfers_updated_at_idx ON v3_transfers(updated_at DESC);
    `)
  },
  down(database: DatabaseSync) {
    database.exec(`
      DROP INDEX IF EXISTS v3_transfers_updated_at_idx;
      DROP TABLE IF EXISTS v3_transfer_chunks;
      DROP TABLE IF EXISTS v3_transfer_items;
      DROP TABLE IF EXISTS v3_transfers;
    `)
  }
} as const
