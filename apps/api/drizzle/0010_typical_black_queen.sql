ALTER TABLE `accounts` ADD `contribution_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `contribution_until_age` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `compound_interval` text DEFAULT 'annually' NOT NULL;