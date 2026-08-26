CREATE TABLE `workspace_events` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`document_id` text,
	`event_type` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_events_type_allowed" CHECK("workspace_events"."event_type" IN ('MATTER_TRASHED', 'MATTER_RESTORED', 'DOCUMENT_TRASHED', 'DOCUMENT_RESTORED')),
	CONSTRAINT "workspace_events_actor_allowed" CHECK("workspace_events"."actor" = 'USER'),
	CONSTRAINT "workspace_events_target_consistent" CHECK((
        "workspace_events"."event_type" IN ('MATTER_TRASHED', 'MATTER_RESTORED')
        AND "workspace_events"."document_id" IS NULL
      ) OR (
        "workspace_events"."event_type" IN ('DOCUMENT_TRASHED', 'DOCUMENT_RESTORED')
        AND "workspace_events"."document_id" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_events_matter_time` ON `workspace_events` (`matter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_events_document_time` ON `workspace_events` (`document_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `workspace_events_scope_insert`
BEFORE INSERT ON `workspace_events`
WHEN (
	NEW.`document_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `documents`
		WHERE `id` = NEW.`document_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'workspace event references must belong to its Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_events_append_only_update`
BEFORE UPDATE ON `workspace_events`
BEGIN
	SELECT RAISE(ABORT, 'workspace events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_events_append_only_delete`
BEFORE DELETE ON `workspace_events`
BEGIN
	SELECT RAISE(ABORT, 'workspace events are append-only');
END;
--> statement-breakpoint
DROP INDEX `uq_documents_matter_file_hash`;--> statement-breakpoint
ALTER TABLE `documents` ADD `deleted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_documents_active_matter_file_hash` ON `documents` (`matter_id`,`file_hash`) WHERE "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_documents_matter_deleted` ON `documents` (`matter_id`,`deleted_at`);--> statement-breakpoint
CREATE TRIGGER `documents_deleted_at_ordered_insert`
BEFORE INSERT ON `documents`
WHEN NEW.`deleted_at` IS NOT NULL AND NEW.`deleted_at` < NEW.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'documents.deleted_at must not precede created_at');
END;
--> statement-breakpoint
CREATE TRIGGER `documents_deleted_at_ordered_update`
BEFORE UPDATE ON `documents`
WHEN NEW.`deleted_at` IS NOT NULL AND NEW.`deleted_at` < NEW.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'documents.deleted_at must not precede created_at');
END;