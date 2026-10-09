import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      network TEXT NOT NULL,
      account_id TEXT NOT NULL,
      token TEXT NOT NULL,
      last_sync_at TEXT,
      UNIQUE (network, account_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      connection_id TEXT NOT NULL REFERENCES connections(id),
      post_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      views INTEGER NOT NULL CHECK (views >= 0),
      likes INTEGER NOT NULL CHECK (likes >= 0),
      comments INTEGER NOT NULL CHECK (comments >= 0),
      PRIMARY KEY (connection_id, post_id)
    );
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
