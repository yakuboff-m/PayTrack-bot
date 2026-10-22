-- PayTrack Bot V1 Schema

CREATE TABLE IF NOT EXISTS distributors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  alias           TEXT NOT NULL UNIQUE,
  bank_name       TEXT NOT NULL,
  account_number  TEXT NOT NULL,
  account_holder  TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id        TEXT NOT NULL,
  pending_topic_id        INTEGER NOT NULL,
  original_message_id     INTEGER NOT NULL,
  distributor_id          INTEGER,
  distributor_snapshot    TEXT,
  amount                  INTEGER,
  currency                TEXT NOT NULL DEFAULT 'KRW',
  status                  TEXT NOT NULL DEFAULT 'PENDING',
  received_at             TEXT NOT NULL,
  paid_at                 TEXT,
  payment_message_id      INTEGER,
  confirmation_message_id INTEGER,
  confirmation_url        TEXT,
  history_message_id      INTEGER,
  metadata_message_id     INTEGER,
  notes                   TEXT DEFAULT '[]',
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(telegram_chat_id, original_message_id),
  FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_distributor_id
  ON transactions(distributor_id);
CREATE INDEX IF NOT EXISTS idx_transactions_pending_topic_id
  ON transactions(pending_topic_id);
CREATE INDEX IF NOT EXISTS idx_transactions_payment_message_id
  ON transactions(payment_message_id);

CREATE TABLE IF NOT EXISTS conversation_states (
  key             TEXT PRIMARY KEY,
  step            TEXT NOT NULL,
  action          TEXT NOT NULL,
  distributor_id  INTEGER,
  data            TEXT NOT NULL DEFAULT '{}',
  started_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_states_started_at
  ON conversation_states(started_at);
