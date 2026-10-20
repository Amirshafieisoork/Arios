CREATE TABLE `arios_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`transcript` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`error` text,
	`report_id` text,
	`file_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`claim` text,
	`claim_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `arios_drafts_user_created` ON `arios_drafts` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `arios_drafts_status_claim` ON `arios_drafts` (`status`,`claim_until`);--> statement-breakpoint
CREATE TABLE `arios_link_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `arios_link_codes_expiry` ON `arios_link_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `arios_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `arios_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `arios_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "arios_state_singleton" CHECK("arios_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `arios_telegram_links` (
	`telegram_user_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arios_telegram_links_user_id_unique` ON `arios_telegram_links` (`user_id`);--> statement-breakpoint
CREATE TABLE `arios_telegram_updates` (
	`update_id` integer PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `arios_telegram_updates_status` ON `arios_telegram_updates` (`status`,`update_id`);