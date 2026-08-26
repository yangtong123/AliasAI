PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace_events` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`document_id` text,
	`superseded_document_id` text,
	`event_type` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_events_type_allowed" CHECK("__new_workspace_events"."event_type" IN ('MATTER_TRASHED', 'MATTER_RESTORED', 'DOCUMENT_TRASHED', 'DOCUMENT_RESTORED', 'DOCUMENT_REPLACED')),
	CONSTRAINT "workspace_events_actor_allowed" CHECK("__new_workspace_events"."actor" = 'USER'),
	CONSTRAINT "workspace_events_target_consistent" CHECK((
        "__new_workspace_events"."event_type" IN ('MATTER_TRASHED', 'MATTER_RESTORED')
        AND "__new_workspace_events"."document_id" IS NULL
      ) OR (
        "__new_workspace_events"."event_type" IN ('DOCUMENT_TRASHED', 'DOCUMENT_RESTORED', 'DOCUMENT_REPLACED')
        AND "__new_workspace_events"."document_id" IS NOT NULL
      )),
	CONSTRAINT "workspace_events_superseded_consistent" CHECK((
        "__new_workspace_events"."event_type" = 'DOCUMENT_REPLACED'
        AND "__new_workspace_events"."superseded_document_id" IS NOT NULL
        AND "__new_workspace_events"."superseded_document_id" <> "__new_workspace_events"."document_id"
      ) OR (
        "__new_workspace_events"."event_type" <> 'DOCUMENT_REPLACED'
        AND "__new_workspace_events"."superseded_document_id" IS NULL
      ))
);
--> statement-breakpoint
INSERT INTO `__new_workspace_events`("id", "matter_id", "document_id", "superseded_document_id", "event_type", "actor", "created_at") SELECT "id", "matter_id", "document_id", NULL, "event_type", "actor", "created_at" FROM `workspace_events`;--> statement-breakpoint
DROP TABLE `workspace_events`;--> statement-breakpoint
ALTER TABLE `__new_workspace_events` RENAME TO `workspace_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
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
OR (
	NEW.`superseded_document_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `documents`
		WHERE `id` = NEW.`superseded_document_id`
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
ALTER TABLE `documents` ADD `supersedes_document_id` text REFERENCES documents(id);--> statement-breakpoint
CREATE INDEX `idx_documents_supersedes` ON `documents` (`supersedes_document_id`);--> statement-breakpoint
CREATE TRIGGER `documents_supersedes_self_insert`
BEFORE INSERT ON `documents`
WHEN NEW.`supersedes_document_id` IS NOT NULL AND NEW.`supersedes_document_id` = NEW.`id`
BEGIN
	SELECT RAISE(ABORT, 'documents.supersedes_document_id cannot reference itself');
END;
--> statement-breakpoint
CREATE TRIGGER `documents_supersedes_self_update`
BEFORE UPDATE ON `documents`
WHEN NEW.`supersedes_document_id` IS NOT NULL AND NEW.`supersedes_document_id` = NEW.`id`
BEGIN
	SELECT RAISE(ABORT, 'documents.supersedes_document_id cannot reference itself');
END;
--> statement-breakpoint
CREATE TRIGGER `documents_supersedes_scope_insert`
BEFORE INSERT ON `documents`
WHEN (
	NEW.`supersedes_document_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `documents`
		WHERE `id` = NEW.`supersedes_document_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'version lineage must stay inside one Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `documents_supersedes_immutable`
BEFORE UPDATE OF `supersedes_document_id` ON `documents`
WHEN NEW.`supersedes_document_id` IS NOT OLD.`supersedes_document_id`
BEGIN
	SELECT RAISE(ABORT, 'documents.supersedes_document_id is immutable');
END;