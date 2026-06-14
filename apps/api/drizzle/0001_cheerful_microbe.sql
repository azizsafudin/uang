CREATE TABLE `account_owners` (
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`account_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `account_owners_user_id_idx` ON `account_owners` (`user_id`);