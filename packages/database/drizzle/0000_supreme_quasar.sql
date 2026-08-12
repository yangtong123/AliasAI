CREATE TABLE `document_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page_id` text NOT NULL,
	`block_type` text NOT NULL,
	`text_cipher` blob NOT NULL,
	`source` text NOT NULL,
	`confidence` real,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`width` real NOT NULL,
	`height` real NOT NULL,
	`reading_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`page_id`) REFERENCES `document_pages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_blocks_x_range" CHECK("document_blocks"."x" >= 0 AND "document_blocks"."x" <= 1),
	CONSTRAINT "document_blocks_y_range" CHECK("document_blocks"."y" >= 0 AND "document_blocks"."y" <= 1),
	CONSTRAINT "document_blocks_width_range" CHECK("document_blocks"."width" >= 0 AND "document_blocks"."width" <= 1),
	CONSTRAINT "document_blocks_height_range" CHECK("document_blocks"."height" >= 0 AND "document_blocks"."height" <= 1),
	CONSTRAINT "document_blocks_horizontal_bounds" CHECK("document_blocks"."x" + "document_blocks"."width" <= 1),
	CONSTRAINT "document_blocks_vertical_bounds" CHECK("document_blocks"."y" + "document_blocks"."height" <= 1),
	CONSTRAINT "document_blocks_confidence_range" CHECK("document_blocks"."confidence" IS NULL OR ("document_blocks"."confidence" >= 0 AND "document_blocks"."confidence" <= 1)),
	CONSTRAINT "document_blocks_reading_order_non_negative" CHECK("document_blocks"."reading_order" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_blocks_page_order` ON `document_blocks` (`page_id`,`reading_order`);--> statement-breakpoint
CREATE TABLE `document_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page_no` integer NOT NULL,
	`original_width` real NOT NULL,
	`original_height` real NOT NULL,
	`rotation` integer DEFAULT 0 NOT NULL,
	`source_type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_pages_page_no_positive" CHECK("document_pages"."page_no" >= 1),
	CONSTRAINT "document_pages_width_positive" CHECK("document_pages"."original_width" > 0),
	CONSTRAINT "document_pages_height_positive" CHECK("document_pages"."original_height" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_document_pages_document_page_no` ON `document_pages` (`document_id`,`page_no`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`original_name_cipher` blob NOT NULL,
	`source_path_cipher` blob,
	`file_hash` text NOT NULL,
	`mime_type` text NOT NULL,
	`parser_type` text,
	`page_count` integer,
	`parse_status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_page_count_positive" CHECK("documents"."page_count" IS NULL OR "documents"."page_count" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_documents_matter_file_hash` ON `documents` (`matter_id`,`file_hash`);--> statement-breakpoint
CREATE INDEX `idx_documents_matter` ON `documents` (`matter_id`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`public_token` text NOT NULL,
	`status` text NOT NULL,
	`merged_into_entity_id` text,
	`resolution_confidence` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "entities_status_allowed" CHECK("entities"."status" IN ('ACTIVE', 'MERGED', 'DELETED')),
	CONSTRAINT "entities_merge_state_consistent" CHECK((
        "entities"."status" = 'MERGED'
        AND "entities"."merged_into_entity_id" IS NOT NULL
        AND "entities"."merged_into_entity_id" <> "entities"."id"
      ) OR (
        "entities"."status" <> 'MERGED'
        AND "entities"."merged_into_entity_id" IS NULL
      )),
	CONSTRAINT "entities_resolution_confidence_range" CHECK("entities"."resolution_confidence" IS NULL OR ("entities"."resolution_confidence" >= 0 AND "entities"."resolution_confidence" <= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_entities_matter_public_token` ON `entities` (`matter_id`,`public_token`);--> statement-breakpoint
CREATE INDEX `idx_entities_matter_type` ON `entities` (`matter_id`,`entity_type`);--> statement-breakpoint
CREATE INDEX `idx_entities_merged_into` ON `entities` (`merged_into_entity_id`);--> statement-breakpoint
CREATE TABLE `entity_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`alias` text NOT NULL,
	`alias_type` text NOT NULL,
	`role` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "entity_aliases_is_primary_boolean" CHECK("entity_aliases"."is_primary" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_entity_aliases_matter_alias` ON `entity_aliases` (`matter_id`,`alias`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alias_primary` ON `entity_aliases` (`entity_id`) WHERE "entity_aliases"."is_primary" = 1;--> statement-breakpoint
CREATE TABLE `entity_constraints` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`entity_a_id` text NOT NULL,
	`entity_b_id` text NOT NULL,
	`constraint_type` text NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_a_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_b_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "entity_constraints_distinct_entities" CHECK("entity_constraints"."entity_a_id" <> "entity_constraints"."entity_b_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_entity_constraints_pair_type` ON `entity_constraints` (`matter_id`,`entity_a_id`,`entity_b_id`,`constraint_type`);--> statement-breakpoint
CREATE TABLE `entity_protected_values` (
	`entity_id` text NOT NULL,
	`protected_value_id` text NOT NULL,
	`relationship_type` text NOT NULL,
	`confidence` real NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`entity_id`, `protected_value_id`),
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`protected_value_id`) REFERENCES `protected_values`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "entity_protected_values_confidence_range" CHECK("entity_protected_values"."confidence" >= 0 AND "entity_protected_values"."confidence" <= 1),
	CONSTRAINT "entity_protected_values_is_primary_boolean" CHECK("entity_protected_values"."is_primary" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `entity_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`source_entity_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`target_entity_id` text NOT NULL,
	`confidence` real NOT NULL,
	`source_document_id` text,
	`source_mention_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_mention_id`) REFERENCES `mentions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "entity_relationships_confidence_range" CHECK("entity_relationships"."confidence" >= 0 AND "entity_relationships"."confidence" <= 1)
);
--> statement-breakpoint
CREATE INDEX `idx_entity_relationships_source` ON `entity_relationships` (`source_entity_id`,`relation_type`);--> statement-breakpoint
CREATE INDEX `idx_entity_relationships_target` ON `entity_relationships` (`target_entity_id`,`relation_type`);--> statement-breakpoint
CREATE TABLE `matters` (
	`id` text PRIMARY KEY NOT NULL,
	`name_cipher` blob NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`document_id` text NOT NULL,
	`page_id` text NOT NULL,
	`block_id` text NOT NULL,
	`entity_id` text,
	`protected_value_id` text,
	`mention_type` text NOT NULL,
	`mention_strength` text NOT NULL,
	`text_cipher` blob NOT NULL,
	`fingerprint` blob,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`x` real,
	`y` real,
	`width` real,
	`height` real,
	`detector` text NOT NULL,
	`confidence` real NOT NULL,
	`review_status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`page_id`) REFERENCES `document_pages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`block_id`) REFERENCES `document_blocks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`protected_value_id`) REFERENCES `protected_values`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mentions_offsets_valid" CHECK("mentions"."start_offset" >= 0 AND "mentions"."end_offset" > "mentions"."start_offset"),
	CONSTRAINT "mentions_confidence_range" CHECK("mentions"."confidence" >= 0 AND "mentions"."confidence" <= 1),
	CONSTRAINT "mentions_bbox_valid" CHECK((
        "mentions"."x" IS NULL
        AND "mentions"."y" IS NULL
        AND "mentions"."width" IS NULL
        AND "mentions"."height" IS NULL
      ) OR (
        "mentions"."x" IS NOT NULL
        AND "mentions"."y" IS NOT NULL
        AND "mentions"."width" IS NOT NULL
        AND "mentions"."height" IS NOT NULL
        AND "mentions"."x" >= 0 AND "mentions"."x" <= 1
        AND "mentions"."y" >= 0 AND "mentions"."y" <= 1
        AND "mentions"."width" >= 0 AND "mentions"."width" <= 1
        AND "mentions"."height" >= 0 AND "mentions"."height" <= 1
        AND "mentions"."x" + "mentions"."width" <= 1
        AND "mentions"."y" + "mentions"."height" <= 1
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_mentions_document` ON `mentions` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_mentions_matter_type` ON `mentions` (`matter_id`,`mention_type`);--> statement-breakpoint
CREATE INDEX `idx_mentions_entity` ON `mentions` (`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_mentions_protected_value` ON `mentions` (`protected_value_id`);--> statement-breakpoint
CREATE TABLE `processing_jobs` (
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
	CONSTRAINT "processing_jobs_progress_range" CHECK("processing_jobs"."progress" >= 0 AND "processing_jobs"."progress" <= 1)
);
--> statement-breakpoint
CREATE INDEX `idx_processing_jobs_document` ON `processing_jobs` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_processing_jobs_status` ON `processing_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `protected_values` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`value_type` text NOT NULL,
	`value_cipher` blob NOT NULL,
	`fingerprint` blob NOT NULL,
	`public_token` text,
	`restore_policy` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_protected_values_matter_type_fingerprint` ON `protected_values` (`matter_id`,`value_type`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_protected_values_lookup` ON `protected_values` (`matter_id`,`value_type`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `resolution_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`mention_id` text NOT NULL,
	`candidate_entity_id` text NOT NULL,
	`score` real NOT NULL,
	`state` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`mention_id`) REFERENCES `mentions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_resolution_candidates_mention_entity` ON `resolution_candidates` (`mention_id`,`candidate_entity_id`);--> statement-breakpoint
CREATE TABLE `resolution_events` (
	`id` text PRIMARY KEY NOT NULL,
	`matter_id` text NOT NULL,
	`event_type` text NOT NULL,
	`entity_id` text,
	`mention_id` text,
	`actor` text NOT NULL,
	`payload_cipher` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matter_id`) REFERENCES `matters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mention_id`) REFERENCES `mentions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_resolution_events_matter_time` ON `resolution_events` (`matter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_resolution_events_entity` ON `resolution_events` (`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_resolution_events_mention` ON `resolution_events` (`mention_id`);--> statement-breakpoint
CREATE TABLE `resolution_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`evidence_type` text NOT NULL,
	`weight` real NOT NULL,
	`score` real NOT NULL,
	`details_cipher` blob,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `resolution_candidates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_resolution_evidence_candidate` ON `resolution_evidence` (`candidate_id`);
--> statement-breakpoint
CREATE TRIGGER `documents_matter_immutable`
BEFORE UPDATE OF `matter_id` ON `documents`
WHEN NEW.`matter_id` <> OLD.`matter_id`
BEGIN
	SELECT RAISE(ABORT, 'documents.matter_id is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `document_pages_document_immutable`
BEFORE UPDATE OF `document_id` ON `document_pages`
WHEN NEW.`document_id` <> OLD.`document_id`
BEGIN
	SELECT RAISE(ABORT, 'document_pages.document_id is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `document_blocks_hierarchy_insert`
BEFORE INSERT ON `document_blocks`
WHEN NOT EXISTS (
	SELECT 1 FROM `document_pages`
	WHERE `id` = NEW.`page_id`
	  AND `document_id` = NEW.`document_id`
)
BEGIN
	SELECT RAISE(ABORT, 'document_blocks page must belong to document');
END;
--> statement-breakpoint
CREATE TRIGGER `document_blocks_hierarchy_immutable`
BEFORE UPDATE OF `document_id`, `page_id` ON `document_blocks`
WHEN NEW.`document_id` <> OLD.`document_id`
  OR NEW.`page_id` <> OLD.`page_id`
BEGIN
	SELECT RAISE(ABORT, 'document_blocks document and page are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `entities_matter_immutable`
BEFORE UPDATE OF `matter_id` ON `entities`
WHEN NEW.`matter_id` <> OLD.`matter_id`
BEGIN
	SELECT RAISE(ABORT, 'entities.matter_id is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `entities_public_token_immutable`
BEFORE UPDATE OF `public_token` ON `entities`
WHEN NEW.`public_token` <> OLD.`public_token`
BEGIN
	SELECT RAISE(ABORT, 'entities.public_token is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `entities_merge_scope_insert`
BEFORE INSERT ON `entities`
WHEN NEW.`status` = 'MERGED'
  AND NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`merged_into_entity_id`
	  AND `matter_id` = NEW.`matter_id`
	  AND `status` = 'ACTIVE'
  )
BEGIN
	SELECT RAISE(ABORT, 'merged entity redirect must target an active Entity in the same Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entities_merge_scope_update`
BEFORE UPDATE OF `status`, `merged_into_entity_id` ON `entities`
WHEN NEW.`status` = 'MERGED'
  AND NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`merged_into_entity_id`
	  AND `matter_id` = NEW.`matter_id`
	  AND `status` = 'ACTIVE'
  )
BEGIN
	SELECT RAISE(ABORT, 'merged entity redirect must target an active Entity in the same Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entities_merge_cycle_insert`
BEFORE INSERT ON `entities`
WHEN NEW.`status` = 'MERGED'
  AND EXISTS (
	WITH RECURSIVE `redirect_chain`(`id`) AS (
		SELECT NEW.`merged_into_entity_id`
		UNION
		SELECT `entities`.`merged_into_entity_id`
		FROM `entities`
		JOIN `redirect_chain` ON `entities`.`id` = `redirect_chain`.`id`
		WHERE `entities`.`merged_into_entity_id` IS NOT NULL
	)
	SELECT 1 FROM `redirect_chain` WHERE `id` = NEW.`id`
  )
BEGIN
	SELECT RAISE(ABORT, 'merged entity redirects must not form a cycle');
END;
--> statement-breakpoint
CREATE TRIGGER `entities_merge_cycle_update`
BEFORE UPDATE OF `status`, `merged_into_entity_id` ON `entities`
WHEN NEW.`status` = 'MERGED'
  AND EXISTS (
	WITH RECURSIVE `redirect_chain`(`id`) AS (
		SELECT NEW.`merged_into_entity_id`
		UNION
		SELECT `entities`.`merged_into_entity_id`
		FROM `entities`
		JOIN `redirect_chain` ON `entities`.`id` = `redirect_chain`.`id`
		WHERE `entities`.`merged_into_entity_id` IS NOT NULL
	)
	SELECT 1 FROM `redirect_chain` WHERE `id` = NEW.`id`
  )
BEGIN
	SELECT RAISE(ABORT, 'merged entity redirects must not form a cycle');
END;
--> statement-breakpoint
CREATE TRIGGER `protected_values_matter_immutable`
BEFORE UPDATE OF `matter_id` ON `protected_values`
WHEN NEW.`matter_id` <> OLD.`matter_id`
BEGIN
	SELECT RAISE(ABORT, 'protected_values.matter_id is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `mentions_scope_insert`
BEFORE INSERT ON `mentions`
WHEN NOT EXISTS (
	SELECT 1 FROM `documents`
	WHERE `id` = NEW.`document_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `document_pages`
	WHERE `id` = NEW.`page_id`
	  AND `document_id` = NEW.`document_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `document_blocks`
	WHERE `id` = NEW.`block_id`
	  AND `document_id` = NEW.`document_id`
	  AND `page_id` = NEW.`page_id`
)
OR (
	NEW.`entity_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `entities`
		WHERE `id` = NEW.`entity_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
OR (
	NEW.`protected_value_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `protected_values`
		WHERE `id` = NEW.`protected_value_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'mention references must belong to its Matter and document hierarchy');
END;
--> statement-breakpoint
CREATE TRIGGER `mentions_scope_update`
BEFORE UPDATE OF `matter_id`, `document_id`, `page_id`, `block_id`, `entity_id`, `protected_value_id` ON `mentions`
WHEN NOT EXISTS (
	SELECT 1 FROM `documents`
	WHERE `id` = NEW.`document_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `document_pages`
	WHERE `id` = NEW.`page_id`
	  AND `document_id` = NEW.`document_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `document_blocks`
	WHERE `id` = NEW.`block_id`
	  AND `document_id` = NEW.`document_id`
	  AND `page_id` = NEW.`page_id`
)
OR (
	NEW.`entity_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `entities`
		WHERE `id` = NEW.`entity_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
OR (
	NEW.`protected_value_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `protected_values`
		WHERE `id` = NEW.`protected_value_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'mention references must belong to its Matter and document hierarchy');
END;
--> statement-breakpoint
CREATE TRIGGER `mentions_location_immutable`
BEFORE UPDATE OF `matter_id`, `document_id`, `page_id`, `block_id` ON `mentions`
WHEN NEW.`matter_id` <> OLD.`matter_id`
  OR NEW.`document_id` <> OLD.`document_id`
  OR NEW.`page_id` <> OLD.`page_id`
  OR NEW.`block_id` <> OLD.`block_id`
BEGIN
	SELECT RAISE(ABORT, 'mention Matter and document location are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `entity_aliases_scope_insert`
BEFORE INSERT ON `entity_aliases`
WHEN NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`entity_id`
	  AND `matter_id` = NEW.`matter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'entity alias must belong to the Entity Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entity_aliases_scope_update`
BEFORE UPDATE OF `matter_id`, `entity_id` ON `entity_aliases`
WHEN NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`entity_id`
	  AND `matter_id` = NEW.`matter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'entity alias must belong to the Entity Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entity_protected_values_scope_insert`
BEFORE INSERT ON `entity_protected_values`
WHEN NOT EXISTS (
	SELECT 1
	FROM `entities` AS e
	JOIN `protected_values` AS p ON p.`id` = NEW.`protected_value_id`
	WHERE e.`id` = NEW.`entity_id`
	  AND e.`matter_id` = p.`matter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'entity and protected value must belong to the same Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entity_protected_values_scope_update`
BEFORE UPDATE OF `entity_id`, `protected_value_id` ON `entity_protected_values`
WHEN NOT EXISTS (
	SELECT 1
	FROM `entities` AS e
	JOIN `protected_values` AS p ON p.`id` = NEW.`protected_value_id`
	WHERE e.`id` = NEW.`entity_id`
	  AND e.`matter_id` = p.`matter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'entity and protected value must belong to the same Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entity_relationships_scope_insert`
BEFORE INSERT ON `entity_relationships`
WHEN NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`source_entity_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`target_entity_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR (
	NEW.`source_document_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `documents`
		WHERE `id` = NEW.`source_document_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
OR (
	NEW.`source_mention_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `mentions`
		WHERE `id` = NEW.`source_mention_id`
		  AND `matter_id` = NEW.`matter_id`
		  AND (
			NEW.`source_document_id` IS NULL
			OR `document_id` = NEW.`source_document_id`
		  )
	)
)
BEGIN
	SELECT RAISE(ABORT, 'entity relationship references must belong to the same Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entity_relationships_scope_update`
BEFORE UPDATE OF `matter_id`, `source_entity_id`, `target_entity_id`, `source_document_id`, `source_mention_id`
ON `entity_relationships`
WHEN NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`source_entity_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`target_entity_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR (
	NEW.`source_document_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `documents`
		WHERE `id` = NEW.`source_document_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
OR (
	NEW.`source_mention_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `mentions`
		WHERE `id` = NEW.`source_mention_id`
		  AND `matter_id` = NEW.`matter_id`
		  AND (
			NEW.`source_document_id` IS NULL
			OR `document_id` = NEW.`source_document_id`
		  )
	)
)
BEGIN
	SELECT RAISE(ABORT, 'entity relationship references must belong to the same Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_candidates_scope_insert`
BEFORE INSERT ON `resolution_candidates`
WHEN NOT EXISTS (
	SELECT 1
	FROM `mentions` AS m
	JOIN `entities` AS e ON e.`id` = NEW.`candidate_entity_id`
	WHERE m.`id` = NEW.`mention_id`
	  AND m.`matter_id` = e.`matter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'resolution candidate must belong to the Mention Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_candidates_scope_update`
BEFORE UPDATE OF `mention_id`, `candidate_entity_id` ON `resolution_candidates`
WHEN NOT EXISTS (
	SELECT 1
	FROM `mentions` AS m
	JOIN `entities` AS e ON e.`id` = NEW.`candidate_entity_id`
	WHERE m.`id` = NEW.`mention_id`
	  AND m.`matter_id` = e.`matter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'resolution candidate must belong to the Mention Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entity_constraints_scope_insert`
BEFORE INSERT ON `entity_constraints`
WHEN NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`entity_a_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`entity_b_id`
	  AND `matter_id` = NEW.`matter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'entity constraint references must belong to the same Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `entity_constraints_scope_update`
BEFORE UPDATE OF `matter_id`, `entity_a_id`, `entity_b_id` ON `entity_constraints`
WHEN NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`entity_a_id`
	  AND `matter_id` = NEW.`matter_id`
)
OR NOT EXISTS (
	SELECT 1 FROM `entities`
	WHERE `id` = NEW.`entity_b_id`
	  AND `matter_id` = NEW.`matter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'entity constraint references must belong to the same Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_events_scope_insert`
BEFORE INSERT ON `resolution_events`
WHEN (
	NEW.`entity_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `entities`
		WHERE `id` = NEW.`entity_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
OR (
	NEW.`mention_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `mentions`
		WHERE `id` = NEW.`mention_id`
		  AND `matter_id` = NEW.`matter_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'resolution event references must belong to its Matter');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_events_append_only_update`
BEFORE UPDATE ON `resolution_events`
BEGIN
	SELECT RAISE(ABORT, 'resolution events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `resolution_events_append_only_delete`
BEFORE DELETE ON `resolution_events`
BEGIN
	SELECT RAISE(ABORT, 'resolution events are append-only');
END;
