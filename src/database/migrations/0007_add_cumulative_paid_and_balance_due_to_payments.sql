-- Migration 0007: Add cumulative_paid and balance_due to payments
ALTER TABLE payments ADD COLUMN cumulative_paid INTEGER;
ALTER TABLE payments ADD COLUMN balance_due INTEGER;
