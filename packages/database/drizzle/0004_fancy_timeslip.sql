CREATE TABLE `ai_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`sanitized_document_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`status` text NOT NULL,
	`request_cipher` blob NOT NULL,
	`response_cipher` blob,
	`error_cipher` blob,
	`created_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sanitized_document_id`) REFERENCES `sanitized_documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_executions_status_allowed" CHECK("ai_executions"."status" IN ('RUNNING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "ai_executions_timestamps_ordered" CHECK("ai_executions"."started_at" >= "ai_executions"."created_at" AND ("ai_executions"."finished_at" IS NULL OR "ai_executions"."finished_at" >= "ai_executions"."started_at")),
	CONSTRAINT "ai_executions_lifecycle_consistent" CHECK((
        "ai_executions"."status" = 'RUNNING'
        AND "ai_executions"."finished_at" IS NULL
        AND "ai_executions"."response_cipher" IS NULL
        AND "ai_executions"."error_cipher" IS NULL
      ) OR (
        "ai_executions"."status" = 'COMPLETED'
        AND "ai_executions"."finished_at" IS NOT NULL
        AND "ai_executions"."response_cipher" IS NOT NULL
        AND "ai_executions"."error_cipher" IS NULL
      ) OR (
        "ai_executions"."status" = 'FAILED'
        AND "ai_executions"."finished_at" IS NOT NULL
        AND "ai_executions"."response_cipher" IS NULL
        AND "ai_executions"."error_cipher" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_ai_executions_sanitized_document` ON `ai_executions` (`sanitized_document_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_executions_matter` ON `ai_executions` (`matter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_executions_status` ON `ai_executions` (`status`);--> statement-breakpoint
CREATE TRIGGER `ai_executions_initial_state_insert`
BEFORE INSERT ON `ai_executions`
WHEN NEW.`status` <> 'RUNNING'
BEGIN
	SELECT RAISE(ABORT, 'AI execution must start in RUNNING state');
END;--> statement-breakpoint
CREATE TRIGGER `ai_executions_scope_insert`
BEFORE INSERT ON `ai_executions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `sanitized_documents` sd
	INNER JOIN `documents` d ON d.`id` = sd.`document_id`
	WHERE sd.`id` = NEW.`sanitized_document_id`
		AND sd.`matter_id` = NEW.`matter_id`
		AND d.`parse_status` = 'SANITIZED'
)
BEGIN
	SELECT RAISE(ABORT, 'AI execution must reference a sanitized Document in the same Matter');
END;--> statement-breakpoint
CREATE TRIGGER `ai_executions_transition_update`
BEFORE UPDATE ON `ai_executions`
WHEN OLD.`status` <> 'RUNNING'
	OR NEW.`status` NOT IN ('COMPLETED', 'FAILED')
	OR NEW.`id` IS NOT OLD.`id`
	OR NEW.`matter_id` IS NOT OLD.`matter_id`
	OR NEW.`sanitized_document_id` IS NOT OLD.`sanitized_document_id`
	OR NEW.`provider_id` IS NOT OLD.`provider_id`
	OR NEW.`request_cipher` IS NOT OLD.`request_cipher`
	OR NEW.`created_at` IS NOT OLD.`created_at`
	OR NEW.`started_at` IS NOT OLD.`started_at`
BEGIN
	SELECT RAISE(ABORT, 'AI execution permits one immutable terminal transition');
END;--> statement-breakpoint
CREATE TRIGGER `ai_executions_no_delete`
BEFORE DELETE ON `ai_executions`
BEGIN
	SELECT RAISE(ABORT, 'AI executions are append-preserving');
END;
