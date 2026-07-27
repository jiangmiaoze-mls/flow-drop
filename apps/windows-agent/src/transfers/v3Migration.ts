import type {DatabaseSync} from 'node:sqlite'

import {v3InitialMigration} from './migrations/001_v3_initial'
import {v3CompletionMigration} from './migrations/002_v3_completion'

type V3Migration = {
  down: (database: DatabaseSync) => void
  id: string
  up: (database: DatabaseSync) => void
}

const migrations: V3Migration[] = [v3InitialMigration, v3CompletionMigration]

export function migrateV3TransferDatabase(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS v3_transfer_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

  for (const migration of migrations) {
    const applied = database.prepare('SELECT id FROM v3_transfer_schema_migrations WHERE id = ?')
      .get(migration.id) as {id: string} | undefined
    if (applied) continue

    inTransaction(database, () => {
      migration.up(database)
      database.prepare('INSERT INTO v3_transfer_schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, Date.now())
    })
  }
}

export function rollbackLatestV3TransferMigration(database: DatabaseSync, force = false): string | null {
  const metadataTable = database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v3_transfer_schema_migrations'
  `).get() as {name: string} | undefined
  if (!metadataTable) return null

  const applied = database.prepare('SELECT id FROM v3_transfer_schema_migrations').all() as Array<{id: string}>
  const migration = [...migrations].reverse().find((candidate) => applied.some((row) => row.id === candidate.id))
  if (!migration) return null

  const rowCount = database.prepare('SELECT COUNT(*) AS count FROM v3_transfers').get() as {count: number}
  if (rowCount.count > 0 && !force) {
    throw new Error('V3 transfer rows exist. Re-run the down migration with --force to discard them.')
  }

  inTransaction(database, () => {
    migration.down(database)
    database.prepare('DELETE FROM v3_transfer_schema_migrations WHERE id = ?').run(migration.id)
    const remaining = database.prepare('SELECT COUNT(*) AS count FROM v3_transfer_schema_migrations').get() as {count: number}
    if (remaining.count === 0) database.exec('DROP TABLE v3_transfer_schema_migrations')
  })
  return migration.id
}

function inTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original migration failure when SQLite has already ended the transaction.
    }
    throw error
  }
}
