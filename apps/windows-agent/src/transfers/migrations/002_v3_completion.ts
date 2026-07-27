import type {DatabaseSync} from 'node:sqlite'

export const v3CompletionMigration = {
  id: '002_v3_completion',
  up(database: DatabaseSync) {
    database.exec(`
      ALTER TABLE v3_transfers ADD COLUMN verifying_bytes INTEGER NOT NULL DEFAULT 0 CHECK(verifying_bytes >= 0);
      ALTER TABLE v3_transfers ADD COLUMN verifying_total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(verifying_total_bytes >= 0);
      ALTER TABLE v3_transfers ADD COLUMN verifying_phase TEXT NOT NULL DEFAULT 'idle'
        CHECK(verifying_phase IN ('idle', 'reading', 'hashing', 'done'));
      ALTER TABLE v3_transfers ADD COLUMN failure_code TEXT;
      ALTER TABLE v3_transfers ADD COLUMN completion_attempt INTEGER NOT NULL DEFAULT 0 CHECK(completion_attempt >= 0);

      ALTER TABLE v3_transfer_items ADD COLUMN item_ordinal INTEGER NOT NULL DEFAULT 0;
      UPDATE v3_transfer_items AS current
      SET item_ordinal = (
        SELECT COUNT(*)
        FROM v3_transfer_items AS preceding
        WHERE preceding.transfer_id = current.transfer_id
          AND preceding.rowid < current.rowid
      );
      CREATE UNIQUE INDEX v3_transfer_items_transfer_ordinal_idx
        ON v3_transfer_items(transfer_id, item_ordinal);

      CREATE TABLE v3_transfer_completion_items (
        transfer_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        requested_content_root TEXT NOT NULL,
        durable_content_root TEXT NOT NULL,
        actual_content_root TEXT,
        PRIMARY KEY (transfer_id, item_id),
        FOREIGN KEY (transfer_id, item_id)
          REFERENCES v3_transfer_items(transfer_id, item_id) ON DELETE CASCADE
      );

      CREATE INDEX v3_transfer_completion_items_transfer_idx
        ON v3_transfer_completion_items(transfer_id);
    `)
  },
  down(database: DatabaseSync) {
    database.exec(`
      DROP INDEX IF EXISTS v3_transfer_completion_items_transfer_idx;
      DROP TABLE IF EXISTS v3_transfer_completion_items;
      DROP INDEX IF EXISTS v3_transfer_items_transfer_ordinal_idx;
      ALTER TABLE v3_transfer_items DROP COLUMN item_ordinal;
      ALTER TABLE v3_transfers DROP COLUMN completion_attempt;
      ALTER TABLE v3_transfers DROP COLUMN failure_code;
      ALTER TABLE v3_transfers DROP COLUMN verifying_phase;
      ALTER TABLE v3_transfers DROP COLUMN verifying_total_bytes;
      ALTER TABLE v3_transfers DROP COLUMN verifying_bytes;
    `)
  }
} as const
