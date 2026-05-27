import Database from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env.DB_PATH ?? './meetassist.db';

export const db = new Database(path.resolve(dbPath));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
