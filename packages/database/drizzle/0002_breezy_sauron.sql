CREATE TABLE `sanitization_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`sanitized_document_id` text NOT NULL,
	`mention_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`public_token` text NOT NULL,
	`alias` text NOT NULL,
	`restore_policy` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sanitized_document_id`) REFERENCES `sanitized_documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mention_id`) REFERENCES `mentions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sanitization_mappings_restore_policy_allowed" CHECK("sanitization_mappings"."restore_policy" IN ('ALWAYS_RESTORE', 'RESTORE_ON_REQUEST', 'NEVER_RESTORE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sanitization_mappings_mention` ON `sanitization_mappings` (`sanitized_document_id`,`mention_id`);--> statement-breakpoint
CREATE INDEX `idx_sanitization_mappings_matter_token` ON `sanitization_mappings` (`matter_id`,`public_token`);--> statement-breakpoint
CREATE TABLE `sanitized_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`sanitized_document_id` text NOT NULL,
	`document_id` text NOT NULL,
	`page_id` text NOT NULL,
	`block_id` text NOT NULL,
	`text_cipher` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sanitized_document_id`) REFERENCES `sanitized_documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`page_id`) REFERENCES `document_pages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`block_id`) REFERENCES `document_blocks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sanitized_blocks_document_block` ON `sanitized_blocks` (`sanitized_document_id`,`block_id`);--> statement-breakpoint
CREATE INDEX `idx_sanitized_blocks_document` ON `sanitized_blocks` (`sanitized_document_id`);--> statement-breakpoint
CREATE TABLE `sanitized_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`document_id` text NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `processing_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sanitized_documents_document` ON `sanitized_documents` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_sanitized_documents_matter` ON `sanitized_documents` (`matter_id`);
--> statement-breakpoint
CREATE TRIGGER `sanitized_documents_scope_insert`
BEFORE INSERT ON `sanitized_documents`
WHEN NOT EXISTS (
	SELECT 1 FROM `documents`
	WHERE `id` = NEW.`document_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `processing_jobs`
	WHERE `id` = NEW.`job_id`
	  AND `document_id` = NEW.`document_id`
	  AND `job_type` = 'SANITIZE'
)
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifact must match its Document Matter and SANITIZE job');
END;
--> statement-breakpoint
CREATE TRIGGER `sanitized_blocks_scope_insert`
BEFORE INSERT ON `sanitized_blocks`
WHEN NOT EXISTS (
	SELECT 1 FROM `document_blocks`
	WHERE `id` = NEW.`block_id`
	  AND `document_id` = NEW.`document_id`
	  AND `page_id` = NEW.`page_id`
)
OR NOT EXISTS (
	SELECT 1
	FROM `sanitized_documents` AS sd
	JOIN `document_blocks` AS b ON b.`id` = NEW.`block_id`
	WHERE sd.`id` = NEW.`sanitized_document_id`
	  AND sd.`document_id` = NEW.`document_id`
	  AND sd.`document_id` = b.`document_id`
)
BEGIN
	SELECT RAISE(ABORT, 'sanitized block must belong to the sanitized Document hierarchy');
END;
--> statement-breakpoint
CREATE TRIGGER `sanitization_mappings_scope_insert`
BEFORE INSERT ON `sanitization_mappings`
WHEN NOT EXISTS (
	SELECT 1 FROM `mentions`
	WHERE `id` = NEW.`mention_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`entity_id`
	  AND `matter_id` = NEW.`matter_id`
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
END;
--> statement-breakpoint
CREATE TRIGGER `sanitized_documents_append_only_update`
BEFORE UPDATE ON `sanitized_documents`
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifacts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sanitized_documents_append_only_delete`
BEFORE DELETE ON `sanitized_documents`
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifacts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sanitized_blocks_append_only_update`
BEFORE UPDATE ON `sanitized_blocks`
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifacts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sanitized_blocks_append_only_delete`
BEFORE DELETE ON `sanitized_blocks`
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifacts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sanitization_mappings_append_only_update`
BEFORE UPDATE ON `sanitization_mappings`
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifacts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sanitization_mappings_append_only_delete`
BEFORE DELETE ON `sanitization_mappings`
BEGIN
	SELECT RAISE(ABORT, 'sanitized artifacts are append-only');
END;