import {mkdirSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'

import {getV3TransferDatabasePath, getV3TransferRoot} from './v3TransferStore'
import {migrateV3TransferDatabase, rollbackLatestV3TransferMigration} from './v3Migration'

function run() {
  const action = process.argv[2]
  const force = process.argv.includes('--force')
  if (action !== 'up' && action !== 'down') {
    throw new Error('Usage: node v3MigrationCli.js <up|down> [--force]')
  }

  const rootDirectory = getV3TransferRoot()
  mkdirSync(rootDirectory, {recursive: true})
  const database = new DatabaseSync(getV3TransferDatabasePath(rootDirectory))
  try {
    database.exec('PRAGMA foreign_keys = ON')
    if (action === 'up') {
      migrateV3TransferDatabase(database)
      return
    }
    rollbackLatestV3TransferMigration(database, force)
  } finally {
    database.close()
  }
}

if (require.main === module) run()
