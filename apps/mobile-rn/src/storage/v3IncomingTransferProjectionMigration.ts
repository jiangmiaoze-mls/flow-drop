import type {SQLiteDatabase} from 'expo-sqlite'

import {V3_TRANSFER_PROJECTION_MIGRATION_UP_SQL} from './v3TransferProjectionMigration'

const MIGRATION_ID = '20260728_v3_incoming_transfer_projection'
const FILE_URI_RESET_MIGRATION_ID = '20260728_v3_file_uri_reset'

const UP_SQL = `
  CREATE TABLE IF NOT EXISTS incoming_transfer_v3_projection (
    transfer_id TEXT PRIMARY KEY NOT NULL,
    peer_device_id TEXT NOT NULL,
    peer_address TEXT NOT NULL,
    peer_control_port INTEGER NOT NULL,
    chunk_size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL,
    failure_code TEXT,
    total_bytes INTEGER NOT NULL,
    confirmed_bytes INTEGER NOT NULL DEFAULT 0,
    remote_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS incoming_transfer_v3_items (
    transfer_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    content_root TEXT NOT NULL,
    PRIMARY KEY (transfer_id, item_id),
    UNIQUE (transfer_id, item_ordinal),
    FOREIGN KEY (transfer_id) REFERENCES incoming_transfer_v3_projection(transfer_id)
  );
  CREATE INDEX IF NOT EXISTS idx_incoming_transfer_v3_projection_updated
    ON incoming_transfer_v3_projection(updated_at DESC);
  INSERT INTO flowdrop_schema_migrations (migration_id, applied_at)
  VALUES ('${MIGRATION_ID}', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(migration_id) DO NOTHING;
`

export async function applyV3IncomingTransferProjectionMigration(database: Pick<SQLiteDatabase, 'execAsync' | 'withExclusiveTransactionAsync'>) {
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(UP_SQL)
  })
}

/**
 * V3 previously persisted external content:// URIs. The product explicitly
 * discards those task records instead of attempting an unsafe URI migration.
 */
export async function applyV3FileUriArchitectureReset(
  database: Pick<SQLiteDatabase, 'execAsync' | 'getFirstAsync' | 'withExclusiveTransactionAsync'>
): Promise<boolean> {
  const applied = await database.getFirstAsync<{migration_id: string}>(
    'SELECT migration_id FROM flowdrop_schema_migrations WHERE migration_id = ?',
    FILE_URI_RESET_MIGRATION_ID
  )
  if (applied) return false

  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(`
      DROP INDEX IF EXISTS idx_incoming_transfer_v3_projection_updated;
      DROP TABLE IF EXISTS incoming_transfer_v3_items;
      DROP TABLE IF EXISTS incoming_transfer_v3_projection;
      DROP INDEX IF EXISTS idx_outgoing_transfer_chunk_digest_conflicts_transfer;
      DROP INDEX IF EXISTS idx_outgoing_transfer_chunk_digests_transfer;
      DROP INDEX IF EXISTS idx_outgoing_transfer_v3_projection_status;
      DROP INDEX IF EXISTS idx_outgoing_transfer_v3_projection_peer_updated;
      DROP TABLE IF EXISTS outgoing_transfer_chunk_digest_conflicts;
      DROP TABLE IF EXISTS outgoing_transfer_chunk_digests;
      DROP TABLE IF EXISTS outgoing_transfer_v3_items;
      DROP TABLE IF EXISTS outgoing_transfer_v3_projection;
    `)
    await transaction.execAsync(V3_TRANSFER_PROJECTION_MIGRATION_UP_SQL)
    await transaction.execAsync(`
      CREATE TABLE incoming_transfer_v3_projection (
        transfer_id TEXT PRIMARY KEY NOT NULL,
        peer_device_id TEXT NOT NULL,
        peer_address TEXT NOT NULL,
        peer_control_port INTEGER NOT NULL,
        chunk_size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        failure_code TEXT,
        total_bytes INTEGER NOT NULL,
        confirmed_bytes INTEGER NOT NULL DEFAULT 0,
        remote_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE incoming_transfer_v3_items (
        transfer_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_ordinal INTEGER NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        content_root TEXT NOT NULL,
        local_uri TEXT NOT NULL,
        PRIMARY KEY (transfer_id, item_id),
        UNIQUE (transfer_id, item_ordinal),
        FOREIGN KEY (transfer_id) REFERENCES incoming_transfer_v3_projection(transfer_id)
      );
      CREATE INDEX idx_incoming_transfer_v3_projection_updated
        ON incoming_transfer_v3_projection(updated_at DESC);
      INSERT INTO flowdrop_schema_migrations (migration_id, applied_at)
      VALUES ('${FILE_URI_RESET_MIGRATION_ID}', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    `)
  })
  return true
}
