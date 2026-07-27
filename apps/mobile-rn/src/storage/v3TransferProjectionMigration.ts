import type {SQLiteDatabase} from 'expo-sqlite'


export const V3_TRANSFER_PROJECTION_MIGRATION_ID = '20260727_v3_transfer_projection'

/**
 * Kept as explicit UP/DOWN SQL so release tooling can inspect and rehearse the
 * migration without depending on the repository implementation.
 */
export const V3_TRANSFER_PROJECTION_MIGRATION_UP_SQL = `
  CREATE TABLE IF NOT EXISTS flowdrop_schema_migrations (
    migration_id TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS outgoing_transfer_v3_projection (
    transfer_id TEXT PRIMARY KEY NOT NULL,
    source_device_id TEXT NOT NULL,
    peer_device_id TEXT NOT NULL,
    peer_address TEXT NOT NULL,
    peer_control_port INTEGER NOT NULL,
    protocol_version INTEGER NOT NULL,
    chunk_size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL,
    failure_code TEXT,
    total_bytes INTEGER NOT NULL,
    confirmed_bytes INTEGER NOT NULL DEFAULT 0,
    submitted_bytes INTEGER NOT NULL DEFAULT 0,
    confirmed_rate_bps REAL NOT NULL DEFAULT 0,
    remote_revision INTEGER NOT NULL DEFAULT 0,
    pending_operation TEXT,
    is_optimistic INTEGER NOT NULL DEFAULT 0,
    operation_id TEXT NOT NULL DEFAULT '',
    operation_generation INTEGER NOT NULL DEFAULT 0,
    last_remote_sync_at INTEGER,
    recovery_state TEXT NOT NULL DEFAULT 'idle',
    recovery_manifest_entries INTEGER NOT NULL DEFAULT 0,
    recovery_manifest_total INTEGER NOT NULL DEFAULT 0,
    verifying_bytes INTEGER NOT NULL DEFAULT 0,
    verifying_total_bytes INTEGER NOT NULL DEFAULT 0,
    verifying_phase TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS outgoing_transfer_v3_items (
    transfer_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    source_uri TEXT NOT NULL,
    PRIMARY KEY (transfer_id, item_id),
    UNIQUE (transfer_id, item_ordinal),
    FOREIGN KEY (transfer_id) REFERENCES outgoing_transfer_v3_projection(transfer_id)
  );

  CREATE TABLE IF NOT EXISTS outgoing_transfer_chunk_digests (
    transfer_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    byte_length INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    confirmed_revision INTEGER NOT NULL,
    confirmed_at INTEGER NOT NULL,
    PRIMARY KEY (transfer_id, item_id, chunk_index),
    FOREIGN KEY (transfer_id, item_id) REFERENCES outgoing_transfer_v3_items(transfer_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS outgoing_transfer_chunk_digest_conflicts (
    transfer_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    local_byte_length INTEGER NOT NULL,
    local_sha256 TEXT NOT NULL,
    agent_byte_length INTEGER NOT NULL,
    agent_sha256 TEXT NOT NULL,
    detected_revision INTEGER NOT NULL,
    detected_at INTEGER NOT NULL,
    PRIMARY KEY (transfer_id, item_id, chunk_index),
    FOREIGN KEY (transfer_id, item_id) REFERENCES outgoing_transfer_v3_items(transfer_id, item_id)
  );

  CREATE INDEX IF NOT EXISTS idx_outgoing_transfer_v3_projection_peer_updated
    ON outgoing_transfer_v3_projection(peer_device_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_outgoing_transfer_v3_projection_status
    ON outgoing_transfer_v3_projection(status, updated_at ASC);
  CREATE INDEX IF NOT EXISTS idx_outgoing_transfer_chunk_digests_transfer
    ON outgoing_transfer_chunk_digests(transfer_id, item_id, chunk_index);
  CREATE INDEX IF NOT EXISTS idx_outgoing_transfer_chunk_digest_conflicts_transfer
    ON outgoing_transfer_chunk_digest_conflicts(transfer_id, item_id, chunk_index);

  INSERT INTO flowdrop_schema_migrations (migration_id, applied_at)
  VALUES ('20260727_v3_transfer_projection', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(migration_id) DO NOTHING;
`

export const V3_TRANSFER_PROJECTION_MIGRATION_DOWN_SQL = `
  DROP INDEX IF EXISTS idx_outgoing_transfer_chunk_digest_conflicts_transfer;
  DROP INDEX IF EXISTS idx_outgoing_transfer_chunk_digests_transfer;
  DROP INDEX IF EXISTS idx_outgoing_transfer_v3_projection_status;
  DROP INDEX IF EXISTS idx_outgoing_transfer_v3_projection_peer_updated;
  DROP TABLE IF EXISTS outgoing_transfer_chunk_digest_conflicts;
  DROP TABLE IF EXISTS outgoing_transfer_chunk_digests;
  DROP TABLE IF EXISTS outgoing_transfer_v3_items;
  DROP TABLE IF EXISTS outgoing_transfer_v3_projection;
  DELETE FROM flowdrop_schema_migrations
  WHERE migration_id = '20260727_v3_transfer_projection';
`

type MigrationDatabase = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'withExclusiveTransactionAsync'>

export async function applyV3TransferProjectionMigration(database: MigrationDatabase): Promise<void> {
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(V3_TRANSFER_PROJECTION_MIGRATION_UP_SQL)
  })
}

export async function rollbackV3TransferProjectionMigration(database: MigrationDatabase): Promise<void> {
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(V3_TRANSFER_PROJECTION_MIGRATION_DOWN_SQL)
  })
}
