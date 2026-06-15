ALTER TABLE `transactions` ADD `linked_transaction_id` text;
--> statement-breakpoint
UPDATE transactions
SET linked_transaction_id = (
  SELECT t2.id FROM transactions t2
  JOIN instruments i2 ON i2.id = t2.instrument_id
  WHERE t2.account_id = transactions.account_id
    AND t2.created_at = transactions.created_at
    AND t2.date = transactions.date
    AND i2.kind != 'currency'
  LIMIT 1
)
WHERE linked_transaction_id IS NULL
  AND instrument_id IN (SELECT id FROM instruments WHERE kind = 'currency')
  AND EXISTS (
    SELECT 1 FROM transactions t3
    JOIN instruments i3 ON i3.id = t3.instrument_id
    WHERE t3.account_id = transactions.account_id
      AND t3.created_at = transactions.created_at
      AND t3.date = transactions.date
      AND i3.kind != 'currency'
  );