-- Migration 0004: Add payments table for partial and incremental payment tracking
CREATE TABLE IF NOT EXISTS payments (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id          INTEGER NOT NULL,
  amount                  INTEGER NOT NULL,
  currency                TEXT NOT NULL DEFAULT 'KRW',
  paid_at                 TEXT NOT NULL,
  payment_message_id      INTEGER,
  confirmed_message_id    INTEGER,
  history_message_id      INTEGER,
  note                    TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_transaction_id ON payments(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_message_id ON payments(payment_message_id);
