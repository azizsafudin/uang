CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`parser_id` text NOT NULL,
	`account_id` text NOT NULL,
	`filename` text NOT NULL,
	`file_hash` text NOT NULL,
	`status` text NOT NULL,
	`row_count_new` integer DEFAULT 0 NOT NULL,
	`row_count_duplicate` integer DEFAULT 0 NOT NULL,
	`row_count_error` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_parsers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_format` text NOT NULL,
	`config` text NOT NULL,
	`fingerprint` text NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`raw` text NOT NULL,
	`date` text,
	`amount_minor` integer,
	`description` text DEFAULT '' NOT NULL,
	`category` text,
	`dedup_hash` text NOT NULL,
	`status` text NOT NULL,
	`error_reason` text,
	`matched_txn_id` text,
	`committed_txn_id` text
);
--> statement-breakpoint
CREATE INDEX `import_rows_batch_idx` ON `import_rows` (`batch_id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `import_batch_id` text;