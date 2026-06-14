CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`target_amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`target_date` text,
	`owner_scope` text DEFAULT 'household' NOT NULL,
	`anchor_date` text,
	`monthly_contribution_minor` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `contribution_growth_rate_bps` integer DEFAULT 800 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `projection_end_age` integer DEFAULT 90 NOT NULL;