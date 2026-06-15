ALTER TABLE `accounts` ADD `spend_type` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `spend_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `spend_rate_bps` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `spend_start_kind` text DEFAULT 'age' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `spend_start_age` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `spend_start_target_minor` integer;