-- Migration 0003: Add notes column to transactions table
ALTER TABLE transactions ADD COLUMN notes TEXT DEFAULT '[]';
