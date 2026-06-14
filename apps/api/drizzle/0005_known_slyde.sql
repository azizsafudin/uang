ALTER TABLE `goals` ADD `spend_type` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `spend_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `goals` ADD `spend_rate_bps` integer;