-- Migration 0008: Add media_file_id and media_type to transactions
ALTER TABLE transactions ADD COLUMN media_file_id TEXT;
ALTER TABLE transactions ADD COLUMN media_type TEXT;
