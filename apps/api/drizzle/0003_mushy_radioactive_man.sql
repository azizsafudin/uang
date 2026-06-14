CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`term` text NOT NULL,
	`target_amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`target_date` text NOT NULL,
	`owner_scope` text DEFAULT 'household' NOT NULL,
	`anchor_date` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `contribution_growth_rate_bps` integer DEFAULT 800 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `projection_end_age` integer DEFAULT 90 NOT NULL;