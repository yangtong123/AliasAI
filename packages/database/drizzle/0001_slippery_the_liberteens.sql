CREATE TABLE `__new_processing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`job_type` text NOT NULL,
	`status` text NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`checkpoint` text,
	`error_cipher` blob,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "processing_jobs_progress_range" CHECK("__new_processing_jobs"."progress" >= 0 AND "__new_processing_jobs"."progress" <= 1),
	CONSTRAINT "processing_jobs_type_allowed" CHECK("__new_processing_jobs"."job_type" IN ('PARSE', 'OCR', 'DETECT', 'RESOLVE', 'SANITIZE', 'VERIFY')),
	CONSTRAINT "processing_jobs_status_allowed" CHECK("__new_processing_jobs"."status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "processing_jobs_timestamps_ordered" CHECK("__new_processing_jobs"."started_at" IS NULL OR ("__new_processing_jobs"."started_at" >= "__new_processing_jobs"."created_at" AND ("__new_processing_jobs"."finished_at" IS NULL OR "__new_processing_jobs"."finished_at" >= "__new_processing_jobs"."started_at"))),
	CONSTRAINT "processing_jobs_lifecycle_consistent" CHECK((
        "__new_processing_jobs"."status" = 'PENDING'
        AND "__new_processing_jobs"."progress" = 0
        AND "__new_processing_jobs"."started_at" IS NULL
        AND "__new_processing_jobs"."finished_at" IS NULL
        AND "__new_processing_jobs"."error_cipher" IS NULL
      ) OR (
        "__new_processing_jobs"."status" = 'RUNNING'
        AND "__new_processing_jobs"."started_at" IS NOT NULL
        AND "__new_processing_jobs"."finished_at" IS NULL
        AND "__new_processing_jobs"."error_cipher" IS NULL
      ) OR (
        "__new_processing_jobs"."status" = 'COMPLETED'
        AND "__new_processing_jobs"."progress" = 1
        AND "__new_processing_jobs"."started_at" IS NOT NULL
        AND "__new_processing_jobs"."finished_at" IS NOT NULL
        AND "__new_processing_jobs"."error_cipher" IS NULL
      ) OR (
        "__new_processing_jobs"."status" = 'FAILED'
        AND "__new_processing_jobs"."started_at" IS NOT NULL
        AND "__new_processing_jobs"."finished_at" IS NOT NULL
        AND "__new_processing_jobs"."error_cipher" IS NOT NULL
      ) OR (
        "__new_processing_jobs"."status" = 'CANCELLED'
        AND "__new_processing_jobs"."started_at" IS NOT NULL
        AND "__new_processing_jobs"."finished_at" IS NOT NULL
      ))
);
--> statement-breakpoint
INSERT INTO `__new_processing_jobs`("id", "document_id", "job_type", "status", "progress", "checkpoint", "error_cipher", "created_at", "started_at", "finished_at") SELECT "id", "document_id", "job_type", "status", "progress", "checkpoint", "error_cipher", "created_at", "started_at", "finished_at" FROM `processing_jobs`;--> statement-breakpoint
DROP TABLE `processing_jobs`;--> statement-breakpoint
ALTER TABLE `__new_processing_jobs` RENAME TO `processing_jobs`;--> statement-breakpoint
CREATE INDEX `idx_processing_jobs_document` ON `processing_jobs` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_processing_jobs_status` ON `processing_jobs` (`status`);
