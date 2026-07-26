declare module 'expo-sqlite' {
  export type SQLiteDatabase = {
    execSync(source: string): void
    getAllSync<T>(source: string, ...parameters: unknown[]): T[]
    getFirstSync<T>(source: string, ...parameters: unknown[]): T | null
    runSync(source: string, ...parameters: unknown[]): void
  }

  export function openDatabaseSync(databaseName: string): SQLiteDatabase
}
