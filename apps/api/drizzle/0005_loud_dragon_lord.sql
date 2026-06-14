PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`term` text NOT NULL,
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
INSERT INTO `__new_goals`("id", "name", "term", "target_amount_minor", "currency", "target_date", "owner_scope", "anchor_date", "monthly_contribution_minor", "sort_order", "created_at", "created_by") SELECT "id", "name", "term", "target_amount_minor", "currency", "target_date", "owner_scope", "anchor_date", "monthly_contribution_minor", "sort_order", "created_at", "created_by" FROM `goals`;--> statement-breakpoint
DROP TABLE `goals`;--> statement-breakpoint
ALTER TABLE `__new_goals` RENAME TO `goals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;