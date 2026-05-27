import Database from 'better-sqlite3';

export function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      slack_user_id TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      organizer_user_id TEXT NOT NULL REFERENCES users(id),
      purpose TEXT NOT NULL,
      document_url TEXT NOT NULL,
      document_title TEXT NOT NULL,
      document_action TEXT NOT NULL,
      confluence_page_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_participants (
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'participant',
      status TEXT NOT NULL DEFAULT 'pending',
      reminder_count INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      PRIMARY KEY (meeting_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS nudges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      slack_channel_id TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      type TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participant_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      nudge_id TEXT REFERENCES nudges(id),
      raw_text TEXT NOT NULL,
      ai_classification TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operator_replies (
      id TEXT PRIMARY KEY,
      participant_message_id TEXT NOT NULL REFERENCES participant_messages(id),
      raw_text TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS doc_checks (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      checked_at TEXT NOT NULL,
      confluence_version INTEGER NOT NULL,
      comment_count INTEGER NOT NULL,
      summary TEXT,
      suggested_nudges TEXT
    );
  `);
}
