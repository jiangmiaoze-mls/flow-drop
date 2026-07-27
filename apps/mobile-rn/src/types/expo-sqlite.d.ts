declare module 'expo-sqlite' {
  export type SQLiteRunResult = {
    changes: number
    lastInsertRowId: number
  }

  export type SQLiteDatabase = {
    execAsync(source: string): Promise<void>
    execSync(source: string): void
    getAllAsync<T>(source: string, ...parameters: unknown[]): Promise<T[]>
    getAllSync<T>(source: string, ...parameters: unknown[]): T[]
    getFirstAsync<T>(source: string, ...parameters: unknown[]): Promise<T | null>
    getFirstSync<T>(source: string, ...parameters: unknown[]): T | null
    runAsync(source: string, ...parameters: unknown[]): Promise<SQLiteRunResult>
    runSync(source: string, ...parameters: unknown[]): void
    withExclusiveTransactionAsync(task: (database: SQLiteDatabase) => Promise<void>): Promise<void>
  }

  export function openDatabaseAsync(databaseName: string): Promise<SQLiteDatabase>
  export function openDatabaseSync(databaseName: string): SQLiteDatabase
}
