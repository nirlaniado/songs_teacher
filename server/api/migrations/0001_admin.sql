CREATE TABLE `admin_audit` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`at` datetime NOT NULL,
	`action` varchar(32) NOT NULL,
	`target_user_id` bigint unsigned NOT NULL,
	`target_username` varchar(32) NOT NULL,
	CONSTRAINT `admin_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `disabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_sign_in_at` datetime;