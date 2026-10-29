-- Migration 0010: Add invoice_type and original_text to transactions
ALTER TABLE transactions ADD COLUMN invoice_type TEXT;
ALTER TABLE transactions ADD COLUMN original_text TEXT;
