import type {DatabaseSync} from 'node:sqlite'

export const V3_TEXT_MESSAGE_MIGRATION_ID = '20260728_v3_text_messages'

export const V3_TEXT_MESSAGE_MIGRATION_UP_SQL = `
  CREATE TABLE IF NOT EXISTS v3_text_schema_migrations (
    migration_id TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS v3_text_messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    sender_device_id TEXT NOT NULL,
    recipient_device_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_bytes INTEGER NOT NULL CHECK(content_bytes >= 1 AND content_bytes <= 1500),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS v3_text_messages_recipient_sequence
    ON v3_text_messages(recipient_device_id, sequence);
  CREATE INDEX IF NOT EXISTS v3_text_messages_conversation
    ON v3_text_messages(sender_device_id, recipient_device_id, sequence);
  INSERT INTO v3_text_schema_migrations (migration_id, applied_at)
  VALUES ('20260728_v3_text_messages', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(migration_id) DO NOTHING;
`

export const V3_TEXT_MESSAGE_MIGRATION_DOWN_SQL = `
  DROP INDEX IF EXISTS v3_text_messages_conversation;
  DROP INDEX IF EXISTS v3_text_messages_recipient_sequence;
  DROP TABLE IF EXISTS v3_text_messages;
  DELETE FROM v3_text_schema_migrations WHERE migration_id = '20260728_v3_text_messages';
  DROP TABLE IF EXISTS v3_text_schema_migrations;
`

export function migrateV3TextMessageDatabase(database: DatabaseSync) {
  inTransaction(database, () => database.exec(V3_TEXT_MESSAGE_MIGRATION_UP_SQL))
}

export function rollbackV3TextMessageDatabase(database: DatabaseSync, force = false) {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v3_text_messages'").get()
  if (!table) return false
  const count = database.prepare('SELECT COUNT(*) AS count FROM v3_text_messages').get() as {count: number}
  if (count.count > 0 && !force) throw new Error('Text message rows exist. Re-run the down migration with --force to discard them.')
  inTransaction(database, () => database.exec(V3_TEXT_MESSAGE_MIGRATION_DOWN_SQL))
  return true
}

function inTransaction(database: DatabaseSync, operation: () => void) {
  database.exec('BEGIN IMMEDIATE')
  try {
    operation()
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Keep the migration failure as the actionable error.
    }
    throw error
  }
}
