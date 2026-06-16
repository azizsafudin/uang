ALTER TABLE `fx_rates` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `market_data_api_key` text;