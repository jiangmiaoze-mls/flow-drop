import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'

import {getV3TextMessageRoot} from './v3TextMessageStore'
import {migrateV3TextMessageDatabase, rollbackV3TextMessageDatabase} from './v3TextMessageMigration'

const command = process.argv[2]
const force = process.argv.includes('--force')
if (command !== 'up' && command !== 'down') throw new Error('Usage: v3TextMessageMigrationCli <up|down> [--force]')

const database = new DatabaseSync(path.join(getV3TextMessageRoot(), 'text-messages.sqlite'))
try {
  if (command === 'up') migrateV3TextMessageDatabase(database)
  else rollbackV3TextMessageDatabase(database, force)
} finally {
  database.close()
}
