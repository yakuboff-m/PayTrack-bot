-- Migration 0002: Add conversation_states table for serverless multi-step wizard
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
