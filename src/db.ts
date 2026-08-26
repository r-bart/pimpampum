import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase } from './migrations.js';

export function openDatabase(databasePath: string): Database.Database {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath, { timeout: 5_000 });
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    if (databasePath !== ':memory:') database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');

    migrateDatabase(database);

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
