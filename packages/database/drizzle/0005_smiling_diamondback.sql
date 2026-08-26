PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sanitization_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`sanitized_document_id` text NOT NULL,
	`mention_id` text NOT NULL,
	`entity_id` text,
	`public_token` text NOT NULL,
	`alias` text NOT NULL,
	`restore_policy` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sanitized_document_id`) REFERENCES `sanitized_documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mention_id`) REFERENCES `mentions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sanitization_mappings_restore_policy_allowed" CHECK("__new_sanitization_mappings"."restore_policy" IN ('ALWAYS_RESTORE', 'RESTORE_ON_REQUEST', 'NEVER_RESTORE'))
);
--> statement-breakpoint
INSERT INTO `__new_sanitization_mappings`("id", "matter_id", "sanitized_document_id", "mention_id", "entity_id", "public_token", "alias", "restore_policy", "created_at") SELECT "id", "matter_id", "sanitized_document_id", "mention_id", "entity_id", "public_token", "alias", "restore_policy", "created_at" FROM `sanitization_mappings`;--> statement-breakpoint
DROP TABLE `sanitization_mappings`;--> statement-breakpoint
ALTER TABLE `__new_sanitization_mappings` RENAME TO `sanitization_mappings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sanitization_mappings_mention` ON `sanitization_mappings` (`sanitized_document_id`,`mention_id`);--> statement-breakpoint
CREATE INDEX `idx_sanitization_mappings_matter_token` ON `sanitization_mappings` (`matter_id`,`public_token`);--> statement-breakpoint
CREATE TRIGGER `sanitization_mappings_scope_insert`
BEFORE INSERT ON `sanitization_mappings`
WHEN NOT EXISTS (
	SELECT 1 FROM `mentions`
	WHERE `id` = NEW.`mention_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR (
	NEW.`entity_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `entities`
		WHERE `id` = NEW.`entity_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
OR NOT EXISTS (
	SELECT 1
	FROM `sanitized_documents` AS sd
	JOIN `mentions` AS m ON m.`id` = NEW.`mention_id`
	WHERE sd.`id` = NEW.`sanitized_document_id`
	  AND sd.`document_id` = m.`document_id`
)
BEGIN
	SELECT RAISE(ABORT, 'sanitization mapping references must belong to its Matter and sanitized Document');
END;--> statement-breakpoint
CREATE TRIGGER `sanitization_mappings_append_only_update`
BEFORE UPDATE ON `sanitization_mappings`
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifacts are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `sanitization_mappings_append_only_delete`
BEFORE DELETE ON `sanitization_mappings`
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifacts are append-only');
END;
