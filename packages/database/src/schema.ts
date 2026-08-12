import { sql } from 'drizzle-orm'
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'
import type {
  AliasType,
  BlockSource,
  BlockType,
  ConstraintSource,
  DocumentParseStatus,
  EntityConstraintType,
  EntityStatus,
  EntityType,
  MentionDetector,
  MentionReviewStatus,
  MentionStrength,
  MentionType,
  MatterStatus,
  PageSourceType,
  ProcessingJobStatus,
  ProcessingJobType,
  ProtectedValueType,
  ResolutionActor,
  ResolutionCandidateState,
  ResolutionEventType,
  RestorePolicy
} from '@aliasai/domain'

const timestamp = (name: string) => integer(name).notNull()
const encrypted = (name: string) => blob(name, { mode: 'buffer' }).notNull()

export const matters = sqliteTable('matters', {
  id: text('id').primaryKey(),
  nameCipher: encrypted('name_cipher'),
  status: text('status').$type<MatterStatus>().notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at')
})

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    matterId: text('matter_id')
      .notNull()
      .references(() => matters.id),
    originalNameCipher: encrypted('original_name_cipher'),
    sourcePathCipher: blob('source_path_cipher', { mode: 'buffer' }),
    fileHash: text('file_hash').notNull(),
    mimeType: text('mime_type').notNull(),
    parserType: text('parser_type'),
    pageCount: integer('page_count'),
    parseStatus: text('parse_status').$type<DocumentParseStatus>().notNull(),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at')
  },
  (table) => [
    uniqueIndex('uq_documents_matter_file_hash').on(table.matterId, table.fileHash),
    index('idx_documents_matter').on(table.matterId),
    check('documents_page_count_positive', sql`${table.pageCount} IS NULL OR ${table.pageCount} >= 1`)
  ]
)

export const documentPages = sqliteTable(
  'document_pages',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    pageNo: integer('page_no').notNull(),
    originalWidth: real('original_width').notNull(),
    originalHeight: real('original_height').notNull(),
    rotation: integer('rotation').notNull().default(0),
    sourceType: text('source_type').$type<PageSourceType>().notNull(),
    createdAt: timestamp('created_at')
  },
  (table) => [
    uniqueIndex('uq_document_pages_document_page_no').on(table.documentId, table.pageNo),
    check('document_pages_page_no_positive', sql`${table.pageNo} >= 1`),
    check('document_pages_width_positive', sql`${table.originalWidth} > 0`),
    check('document_pages_height_positive', sql`${table.originalHeight} > 0`)
  ]
)

export const documentBlocks = sqliteTable(
  'document_blocks',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    pageId: text('page_id')
      .notNull()
      .references(() => documentPages.id),
    blockType: text('block_type').$type<BlockType>().notNull(),
    textCipher: encrypted('text_cipher'),
    source: text('source').$type<BlockSource>().notNull(),
    confidence: real('confidence'),
    x: real('x').notNull(),
    y: real('y').notNull(),
    width: real('width').notNull(),
    height: real('height').notNull(),
    readingOrder: integer('reading_order').notNull(),
    createdAt: timestamp('created_at')
  },
  (table) => [
    index('idx_blocks_page_order').on(table.pageId, table.readingOrder),
    check('document_blocks_x_range', sql`${table.x} >= 0 AND ${table.x} <= 1`),
    check('document_blocks_y_range', sql`${table.y} >= 0 AND ${table.y} <= 1`),
    check('document_blocks_width_range', sql`${table.width} >= 0 AND ${table.width} <= 1`),
    check('document_blocks_height_range', sql`${table.height} >= 0 AND ${table.height} <= 1`),
    check('document_blocks_horizontal_bounds', sql`${table.x} + ${table.width} <= 1`),
    check('document_blocks_vertical_bounds', sql`${table.y} + ${table.height} <= 1`),
    check(
      'document_blocks_confidence_range',
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`
    ),
    check('document_blocks_reading_order_non_negative', sql`${table.readingOrder} >= 0`)
  ]
)

export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    matterId: text('matter_id')
      .notNull()
      .references(() => matters.id),
    entityType: text('entity_type').$type<EntityType>().notNull(),
    publicToken: text('public_token').notNull(),
    status: text('status').$type<EntityStatus>().notNull(),
    mergedIntoEntityId: text('merged_into_entity_id').references((): AnySQLiteColumn => entities.id),
    resolutionConfidence: real('resolution_confidence'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at')
  },
  (table) => [
    uniqueIndex('uq_entities_matter_public_token').on(table.matterId, table.publicToken),
    index('idx_entities_matter_type').on(table.matterId, table.entityType),
    index('idx_entities_merged_into').on(table.mergedIntoEntityId),
    check('entities_status_allowed', sql`${table.status} IN ('ACTIVE', 'MERGED', 'DELETED')`),
    check(
      'entities_merge_state_consistent',
      sql`(
        ${table.status} = 'MERGED'
        AND ${table.mergedIntoEntityId} IS NOT NULL
        AND ${table.mergedIntoEntityId} <> ${table.id}
      ) OR (
        ${table.status} <> 'MERGED'
        AND ${table.mergedIntoEntityId} IS NULL
      )`
    ),
    check(
      'entities_resolution_confidence_range',
      sql`${table.resolutionConfidence} IS NULL OR (${table.resolutionConfidence} >= 0 AND ${table.resolutionConfidence} <= 1)`
    )
  ]
)

export const protectedValues = sqliteTable(
  'protected_values',
  {
    id: text('id').primaryKey(),
    matterId: text('matter_id')
      .notNull()
      .references(() => matters.id),
    valueType: text('value_type').$type<ProtectedValueType>().notNull(),
    valueCipher: encrypted('value_cipher'),
    fingerprint: encrypted('fingerprint'),
    publicToken: text('public_token'),
    restorePolicy: text('restore_policy').$type<RestorePolicy>().notNull(),
    createdAt: timestamp('created_at')
  },
  (table) => [
    uniqueIndex('uq_protected_values_matter_type_fingerprint').on(table.matterId, table.valueType, table.fingerprint),
    index('idx_protected_values_lookup').on(table.matterId, table.valueType, table.fingerprint)
  ]
)

export const mentions = sqliteTable(
  'mentions',
  {
    id: text('id').primaryKey(),
    matterId: text('matter_id')
      .notNull()
      .references(() => matters.id),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    pageId: text('page_id')
      .notNull()
      .references(() => documentPages.id),
    blockId: text('block_id')
      .notNull()
      .references(() => documentBlocks.id),
    entityId: text('entity_id').references(() => entities.id),
    protectedValueId: text('protected_value_id').references(() => protectedValues.id),
    mentionType: text('mention_type').$type<MentionType>().notNull(),
    mentionStrength: text('mention_strength').$type<MentionStrength>().notNull(),
    textCipher: encrypted('text_cipher'),
    fingerprint: blob('fingerprint', { mode: 'buffer' }),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    x: real('x'),
    y: real('y'),
    width: real('width'),
    height: real('height'),
    detector: text('detector').$type<MentionDetector>().notNull(),
    confidence: real('confidence').notNull(),
    reviewStatus: text('review_status').$type<MentionReviewStatus>().notNull(),
    createdAt: timestamp('created_at')
  },
  (table) => [
    index('idx_mentions_document').on(table.documentId),
    index('idx_mentions_matter_type').on(table.matterId, table.mentionType),
    index('idx_mentions_entity').on(table.entityId),
    index('idx_mentions_protected_value').on(table.protectedValueId),
    check('mentions_offsets_valid', sql`${table.startOffset} >= 0 AND ${table.endOffset} > ${table.startOffset}`),
    check('mentions_confidence_range', sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
    check(
      'mentions_bbox_valid',
      sql`(
        ${table.x} IS NULL
        AND ${table.y} IS NULL
        AND ${table.width} IS NULL
        AND ${table.height} IS NULL
      ) OR (
        ${table.x} IS NOT NULL
        AND ${table.y} IS NOT NULL
        AND ${table.width} IS NOT NULL
        AND ${table.height} IS NOT NULL
        AND ${table.x} >= 0 AND ${table.x} <= 1
        AND ${table.y} >= 0 AND ${table.y} <= 1
        AND ${table.width} >= 0 AND ${table.width} <= 1
        AND ${table.height} >= 0 AND ${table.height} <= 1
        AND ${table.x} + ${table.width} <= 1
        AND ${table.y} + ${table.height} <= 1
      )`
    )
  ]
)

export const entityAliases = sqliteTable(
  'entity_aliases',
  {
    id: text('id').primaryKey(),
    matterId: text('matter_id')
      .notNull()
      .references(() => matters.id),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id),
    alias: text('alias').notNull(),
    aliasType: text('alias_type').$type<AliasType>().notNull(),
    role: text('role'),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestamp('created_at')
  },
  (table) => [
    uniqueIndex('uq_entity_aliases_matter_alias').on(table.matterId, table.alias),
    uniqueIndex('idx_alias_primary').on(table.entityId).where(sql`${table.isPrimary} = 1`),
    check('entity_aliases_is_primary_boolean', sql`${table.isPrimary} IN (0, 1)`)
  ]
)

export const entityProtectedValues = sqliteTable(
  'entity_protected_values',
  {
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id),
    protectedValueId: text('protected_value_id')
      .notNull()
      .references(() => protectedValues.id),
    relationshipType: text('relationship_type').notNull(),
    confidence: real('confidence').notNull(),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestamp('created_at')
  },
  (table) => [
    primaryKey({ columns: [table.entityId, table.protectedValueId] }),
    check('entity_protected_values_confidence_range', sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
    check('entity_protected_values_is_primary_boolean', sql`${table.isPrimary} IN (0, 1)`)
  ]
)

export const entityRelationships = sqliteTable(
  'entity_relationships',
  {
    id: text('id').primaryKey(),
    matterId: text('matter_id')
      .notNull()
      .references(() => matters.id),
    sourceEntityId: text('source_entity_id')
      .notNull()
      .references(() => entities.id),
    relationType: text('relation_type').notNull(),
    targetEntityId: text('target_entity_id')
      .notNull()
      .references(() => entities.id),
    confidence: real('confidence').notNull(),
    sourceDocumentId: text('source_document_id').references(() => documents.id),
    sourceMentionId: text('source_mention_id').references(() => mentions.id),
    createdAt: timestamp('created_at')
  },
  (table) => [
    index('idx_entity_relationships_source').on(table.sourceEntityId, table.relationType),
    index('idx_entity_relationships_target').on(table.targetEntityId, table.relationType),
    check('entity_relationships_confidence_range', sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`)
  ]
)

export const resolutionCandidates = sqliteTable(
  'resolution_candidates',
  {
    id: text('id').primaryKey(),
    mentionId: text('mention_id')
      .notNull()
      .references(() => mentions.id),
    candidateEntityId: text('candidate_entity_id')
      .notNull()
      .references(() => entities.id),
    score: real('score').notNull(),
    state: text('state').$type<ResolutionCandidateState>().notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    createdAt: timestamp('created_at'),
    resolvedAt: integer('resolved_at')
  },
  (table) => [uniqueIndex('uq_resolution_candidates_mention_entity').on(table.mentionId, table.candidateEntityId)]
)

export const resolutionEvidence = sqliteTable(
  'resolution_evidence',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => resolutionCandidates.id),
    evidenceType: text('evidence_type').notNull(),
    weight: real('weight').notNull(),
    score: real('score').notNull(),
    detailsCipher: blob('details_cipher', { mode: 'buffer' }),
    createdAt: timestamp('created_at')
  },
  (table) => [index('idx_resolution_evidence_candidate').on(table.candidateId)]
)

export const entityConstraints = sqliteTable(
  'entity_constraints',
  {
    id: text('id').primaryKey(),
    matterId: text('matter_id')
      .notNull()
      .references(() => matters.id),
    entityAId: text('entity_a_id')
      .notNull()
      .references(() => entities.id),
    entityBId: text('entity_b_id')
      .notNull()
      .references(() => entities.id),
    constraintType: text('constraint_type').$type<EntityConstraintType>().notNull(),
    reason: text('reason').notNull(),
    source: text('source').$type<ConstraintSource>().notNull(),
    createdAt: timestamp('created_at')
  },
  (table) => [
    uniqueIndex('uq_entity_constraints_pair_type').on(
      table.matterId,
      table.entityAId,
      table.entityBId,
      table.constraintType
    ),
    check('entity_constraints_distinct_entities', sql`${table.entityAId} <> ${table.entityBId}`)
  ]
)

export const resolutionEvents = sqliteTable(
  'resolution_events',
  {
    id: text('id').primaryKey(),
    matterId: text('matter_id')
      .notNull()
      .references(() => matters.id),
    eventType: text('event_type').$type<ResolutionEventType>().notNull(),
    entityId: text('entity_id').references(() => entities.id),
    mentionId: text('mention_id').references(() => mentions.id),
    actor: text('actor').$type<ResolutionActor>().notNull(),
    payloadCipher: encrypted('payload_cipher'),
    createdAt: timestamp('created_at')
  },
  (table) => [
    index('idx_resolution_events_matter_time').on(table.matterId, table.createdAt),
    index('idx_resolution_events_entity').on(table.entityId),
    index('idx_resolution_events_mention').on(table.mentionId)
  ]
)

export const processingJobs = sqliteTable(
  'processing_jobs',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    jobType: text('job_type').$type<ProcessingJobType>().notNull(),
    status: text('status').$type<ProcessingJobStatus>().notNull(),
    progress: real('progress').notNull().default(0),
    checkpoint: text('checkpoint'),
    errorCipher: blob('error_cipher', { mode: 'buffer' }),
    createdAt: timestamp('created_at'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at')
  },
  (table) => [
    index('idx_processing_jobs_document').on(table.documentId),
    index('idx_processing_jobs_status').on(table.status),
    check('processing_jobs_progress_range', sql`${table.progress} >= 0 AND ${table.progress} <= 1`)
  ]
)

export const schema = {
  matters,
  documents,
  documentPages,
  documentBlocks,
  mentions,
  entities,
  entityAliases,
  protectedValues,
  entityProtectedValues,
  entityRelationships,
  resolutionCandidates,
  resolutionEvidence,
  entityConstraints,
  resolutionEvents,
  processingJobs
}
