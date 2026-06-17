CREATE TABLE `goal_accounts` (
	`goal_id` text NOT NULL,
	`account_id` text NOT NULL,
	PRIMARY KEY(`goal_id`, `account_id`)
);
--> statement-breakpoint
CREATE INDEX `goal_accounts_account_idx` ON `goal_accounts` (`account_id`);--> statement-breakpoint
ALTER TABLE `goals` ADD `contribution_account_id` text;