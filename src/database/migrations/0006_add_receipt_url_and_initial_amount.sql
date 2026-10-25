-- Migration 0006: Add initial_amount to transactions and receipt fields to payments
ALTER TABLE transactions ADD COLUMN initial_amount INTEGER;
ALTER TABLE payments ADD COLUMN receipt_message_id INTEGER;
ALTER TABLE payments ADD COLUMN receipt_url TEXT;

UPDATE transactions
SET initial_amount = amount - COALESCE(
  (SELECT SUM(amount) FROM invoice_additions WHERE transaction_id = transactions.id),
  0
)
WHERE initial_amount IS NULL AND amount IS NOT NULL;
