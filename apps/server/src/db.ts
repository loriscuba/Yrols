import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bank_connections (
  id TEXT PRIMARY KEY,
  bank_name TEXT,
  country TEXT,
  valid_until TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  bank_name TEXT,
  name TEXT,
  iban TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  source TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_balances (
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  PRIMARY KEY (account_id, type, date)
);
CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  booking_date TEXT NOT NULL,
  value_date TEXT,
  description TEXT,
  counterparty TEXT,
  status TEXT NOT NULL DEFAULT 'BOOK',
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON bank_transactions(booking_date);
CREATE TABLE IF NOT EXISTS bank_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  synced_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'altro',
  amount REAL NOT NULL,
  due_date TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  paid_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'altro',
  due_date TEXT NOT NULL,
  amount REAL,
  recurrence TEXT NOT NULL DEFAULT 'none',
  done_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  remind_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normale',
  done_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  sender TEXT,
  subject TEXT,
  received_at TEXT,
  kind TEXT NOT NULL,
  provider TEXT,
  bill_kind TEXT,
  title TEXT,
  amount REAL,
  due_date TEXT,
  snippet TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_id INTEGER,
  created_at TEXT NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Esegue fn in una transazione. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
