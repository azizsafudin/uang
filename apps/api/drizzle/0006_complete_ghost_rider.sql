CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`date` text NOT NULL,
	`units_delta` integer NOT NULL,
	`unit_price_scaled` integer,
	`fees_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
