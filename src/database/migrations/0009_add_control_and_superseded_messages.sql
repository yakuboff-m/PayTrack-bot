-- Migration 0009: Add account control and superseded message tracking
ALTER TABLE transactions ADD COLUMN account_control_message_id INTEGER;
ALTER TABLE transactions ADD COLUMN historical_control_message_ids TEXT DEFAULT '[]';
ALTER TABLE transactions ADD COLUMN superseded_message_ids TEXT DEFAULT '[]';
