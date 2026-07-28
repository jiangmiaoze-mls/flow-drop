import type {SQLiteDatabase} from 'expo-sqlite'

export const V3_TEXT_MESSAGE_MIGRATION_ID = '20260728_v3_text_messages'

export const V3_TEXT_MESSAGE_MIGRATION_UP_SQL = `
  CREATE TABLE IF NOT EXISTS flowdrop_schema_migrations (
    migration_id TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS v3_text_messages (
    message_id TEXT PRIMARY KEY NOT NULL,
    peer_device_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    recipient_device_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    delivery_state TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_v3_text_messages_peer_sequence
    ON v3_text_messages(peer_device_id, sequence, created_at);
  INSERT INTO flowdrop_schema_migrations (migration_id, applied_at)
  VALUES ('20260728_v3_text_messages', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(migration_id) DO NOTHING;
`

export const V3_TEXT_MESSAGE_MIGRATION_DOWN_SQL = `
  DROP INDEX IF EXISTS idx_v3_text_messages_peer_sequence;
  DROP TABLE IF EXISTS v3_text_messages;
  DELETE FROM flowdrop_schema_migrations WHERE migration_id = '20260728_v3_text_messages';
`

type MigrationDatabase = Pick<SQLiteDatabase, 'execAsync' | 'withExclusiveTransactionAsync'>

export async function applyV3TextMessageMigration(database: MigrationDatabase) {
  await database.withExclusiveTransactionAsync(async (transaction) => transaction.execAsync(V3_TEXT_MESSAGE_MIGRATION_UP_SQL))
}

export async function rollbackV3TextMessageMigration(database: MigrationDatabase) {
  await database.withExclusiveTransactionAsync(async (transaction) => transaction.execAsync(V3_TEXT_MESSAGE_MIGRATION_DOWN_SQL))
}
