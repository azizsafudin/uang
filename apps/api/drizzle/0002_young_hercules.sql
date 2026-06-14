CREATE TABLE `member_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`birth_year` integer
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `growth_rate_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `accessible_from_age` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `early_withdrawal` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `early_haircut_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `illiquid` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `liquidation_age` integer;