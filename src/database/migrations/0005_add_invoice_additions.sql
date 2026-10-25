-- Migration 0005: Add invoice_additions table for incremental delivery/invoice additions
CREATE TABLE IF NOT EXISTS invoice_additions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  INTEGER NOT NULL,
  amount          INTEGER NOT NULL,
  added_at        TEXT NOT NULL,
  message_id      INTEGER,
  media_file_id   TEXT,
  media_type      TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invoice_additions_transaction_id ON invoice_additions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_invoice_additions_message_id ON invoice_additions(message_id);

