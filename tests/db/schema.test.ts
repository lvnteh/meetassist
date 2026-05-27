import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../src/db/schema';

describe('createTables', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    createTables(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('users');
    expect(names).toContain('meetings');
    expect(names).toContain('meeting_participants');
    expect(names).toContain('nudges');
    expect(names).toContain('participant_messages');
    expect(names).toContain('operator_replies');
    expect(names).toContain('doc_checks');
  });

  it('is idempotent — running twice does not throw', () => {
    expect(() => {
      createTables(db);
      createTables(db);
    }).not.toThrow();
  });
});
