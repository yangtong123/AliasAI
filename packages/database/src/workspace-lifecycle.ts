import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import type { Document, Matter, WorkspaceEvent } from '@aliasai/domain'
import { assertDocument, assertWorkspaceEvent } from '@aliasai/domain'
import type { AliasAiDatabase } from './client'
import { matterIsAvailable } from './repositories'
import { aiExecutions, documents, matters, processingJobs, sanitizedDocuments, workspaceEvents } from './schema'

/** Raised when a workspace lifecycle mutation must fail closed. */
export class WorkspaceLifecycleRepositoryError extends Error {
  constructor(
    readonly code:
      | 'MATTER_NOT_FOUND'
      | 'DOCUMENT_NOT_FOUND'
      | 'DOCUMENT_UNAVAILABLE'
      | 'MATTER_UNAVAILABLE'
      | 'MATTER_SCOPE_MISMATCH'
      | 'TIMESTAMP_INVALID'
      | 'MATTER_BUSY'
      | 'DOCUMENT_BUSY'
      | 'RESTORE_CONFLICT',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'WorkspaceLifecycleRepositoryError'
  }
}

export interface TrashMatterInput {
  readonly matterId: string
  readonly event: WorkspaceEvent
}

export interface TrashDocumentInput {
  readonly documentId: string
  readonly event: WorkspaceEvent
}

/** The replacement Document row created by a one-step replacement. */
export interface ReplacementDocumentInput {
  readonly id: string
  readonly matterId: string
  readonly originalNameCipher: Buffer
  readonly sourcePathCipher?: Buffer
  readonly fileHash: string
  readonly mimeType: string
  readonly parseStatus: 'IMPORTED'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ReplaceDocumentInput {
  readonly supersededDocumentId: string
  readonly replacement: ReplacementDocumentInput
  /** DOCUMENT_REPLACED with documentId = replacement.id and supersededDocumentId set. */
  readonly event: WorkspaceEvent
}

/** A deleted Matter with its encrypted display name for the trash view. */
export interface TrashedMatterItem {
  readonly matter: Matter
  readonly nameCipher: Buffer
}

/**
 * An individually trashed Document under a non-deleted Matter. Documents of a
 * deleted Matter are not listed separately: restoring the Matter restores the
 * whole child tree and avoids duplicate entries.
 */
export interface TrashedDocumentItem {
  readonly document: Document
  readonly originalNameCipher: Buffer
  readonly matterNameCipher: Buffer
}

export interface WorkspaceTrashSource {
  readonly matters: readonly TrashedMatterItem[]
  readonly documents: readonly TrashedDocumentItem[]
}

interface WorkspaceEventInsert {
  readonly id: string
  readonly matterId: string
  readonly documentId: string | null
  readonly supersededDocumentId: string | null
  readonly eventType: WorkspaceEvent['type']
  readonly actor: WorkspaceEvent['actor']
  readonly createdAt: number
}

function toEventInsert(event: WorkspaceEvent): WorkspaceEventInsert {
  return {
    id: event.id,
    matterId: event.matterId,
    documentId: event.documentId ?? null,
    supersededDocumentId: event.supersededDocumentId ?? null,
    eventType: event.type,
    actor: event.actor,
    createdAt: event.createdAt
  }
}

/**
 * Atomic trash/restore transitions for Matters and Documents. Each mutation is
 * one SQLite transaction: state change plus one append-only WorkspaceEvent, or
 * nothing. Trash never rewrites child Documents, Entities, Mentions, mappings,
 * sanitized artifacts, or AI execution history.
 */
export class WorkspaceLifecycleRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  trashMatter(input: TrashMatterInput): { readonly changed: boolean } {
    assertWorkspaceEvent(input.event)
    if (input.event.type !== 'MATTER_TRASHED' || input.event.matterId !== input.matterId) {
      throw new WorkspaceLifecycleRepositoryError('MATTER_SCOPE_MISMATCH', 'Trash event does not target this Matter')
    }
    return this.db.transaction((transaction) => {
      const matter = transaction.select().from(matters).where(eq(matters.id, input.matterId)).get()
      if (matter === undefined) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_NOT_FOUND', 'Matter was not found')
      }
      if (matter.status === 'DELETED') return { changed: false }
      if (input.event.createdAt < matter.updatedAt) {
        throw new WorkspaceLifecycleRepositoryError('TIMESTAMP_INVALID', 'Trash timestamp must not move backwards')
      }
      this.assertMatterIdle(transaction, input.matterId)

      const result = transaction
        .update(matters)
        .set({ status: 'DELETED', updatedAt: input.event.createdAt })
        .where(and(eq(matters.id, input.matterId), ne(matters.status, 'DELETED')))
        .run()
      if (result.changes !== 1) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_BUSY', 'Matter state changed before trash completed')
      }
      transaction.insert(workspaceEvents).values(toEventInsert(input.event)).run()
      return { changed: true }
    })
  }

  restoreMatter(input: TrashMatterInput): { readonly changed: boolean } {
    assertWorkspaceEvent(input.event)
    if (input.event.type !== 'MATTER_RESTORED' || input.event.matterId !== input.matterId) {
      throw new WorkspaceLifecycleRepositoryError('MATTER_SCOPE_MISMATCH', 'Restore event does not target this Matter')
    }
    return this.db.transaction((transaction) => {
      const matter = transaction.select().from(matters).where(eq(matters.id, input.matterId)).get()
      if (matter === undefined) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_NOT_FOUND', 'Matter was not found')
      }
      if (matter.status !== 'DELETED') return { changed: false }
      if (input.event.createdAt < matter.updatedAt) {
        throw new WorkspaceLifecycleRepositoryError('TIMESTAMP_INVALID', 'Restore timestamp must not move backwards')
      }

      // Child rows are untouched: a Document trashed before the Matter stays
      // trashed after the Matter is restored.
      const result = transaction
        .update(matters)
        .set({ status: 'ACTIVE', updatedAt: input.event.createdAt })
        .where(and(eq(matters.id, input.matterId), eq(matters.status, 'DELETED')))
        .run()
      if (result.changes !== 1) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_BUSY', 'Matter state changed before restore completed')
      }
      transaction.insert(workspaceEvents).values(toEventInsert(input.event)).run()
      return { changed: true }
    })
  }

  trashDocument(input: TrashDocumentInput): { readonly changed: boolean } {
    assertWorkspaceEvent(input.event)
    if (input.event.type !== 'DOCUMENT_TRASHED' || input.event.documentId !== input.documentId) {
      throw new WorkspaceLifecycleRepositoryError('MATTER_SCOPE_MISMATCH', 'Trash event does not target this Document')
    }
    return this.db.transaction((transaction) => {
      const document = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      if (document === undefined) {
        throw new WorkspaceLifecycleRepositoryError('DOCUMENT_NOT_FOUND', 'Document was not found')
      }
      if (document.matterId !== input.event.matterId) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_SCOPE_MISMATCH', 'Document belongs to another Matter')
      }
      const matter = transaction.select().from(matters).where(eq(matters.id, document.matterId)).get()
      if (matter === undefined) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_NOT_FOUND', 'Matter was not found')
      }
      if (matter.status === 'DELETED') {
        throw new WorkspaceLifecycleRepositoryError('MATTER_UNAVAILABLE', 'Matter is in the trash')
      }
      if (document.deletedAt !== null) return { changed: false }
      if (
        input.event.createdAt < document.updatedAt ||
        input.event.createdAt < document.createdAt
      ) {
        throw new WorkspaceLifecycleRepositoryError('TIMESTAMP_INVALID', 'Trash timestamp must not move backwards')
      }
      this.assertDocumentIdle(transaction, input.documentId)

      const result = transaction
        .update(documents)
        .set({ deletedAt: input.event.createdAt, updatedAt: input.event.createdAt })
        .where(and(eq(documents.id, input.documentId), isNull(documents.deletedAt)))
        .run()
      if (result.changes !== 1) {
        throw new WorkspaceLifecycleRepositoryError('DOCUMENT_BUSY', 'Document state changed before trash completed')
      }
      transaction.insert(workspaceEvents).values(toEventInsert(input.event)).run()
      return { changed: true }
    })
  }

  restoreDocument(input: TrashDocumentInput): { readonly changed: boolean } {
    assertWorkspaceEvent(input.event)
    if (input.event.type !== 'DOCUMENT_RESTORED' || input.event.documentId !== input.documentId) {
      throw new WorkspaceLifecycleRepositoryError('MATTER_SCOPE_MISMATCH', 'Restore event does not target this Document')
    }
    return this.db.transaction((transaction) => {
      const document = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      if (document === undefined) {
        throw new WorkspaceLifecycleRepositoryError('DOCUMENT_NOT_FOUND', 'Document was not found')
      }
      if (document.matterId !== input.event.matterId) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_SCOPE_MISMATCH', 'Document belongs to another Matter')
      }
      const matter = transaction.select().from(matters).where(eq(matters.id, document.matterId)).get()
      if (matter === undefined) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_NOT_FOUND', 'Matter was not found')
      }
      if (matter.status === 'DELETED') {
        throw new WorkspaceLifecycleRepositoryError('MATTER_UNAVAILABLE', 'Restore the parent Matter first')
      }
      if (document.deletedAt === null) return { changed: false }
      if (input.event.createdAt < document.updatedAt) {
        throw new WorkspaceLifecycleRepositoryError('TIMESTAMP_INVALID', 'Restore timestamp must not move backwards')
      }
      const conflict = transaction
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.matterId, document.matterId),
            eq(documents.fileHash, document.fileHash),
            isNull(documents.deletedAt),
            ne(documents.id, input.documentId)
          )
        )
        .limit(1)
        .get()
      if (conflict !== undefined) {
        throw new WorkspaceLifecycleRepositoryError(
          'RESTORE_CONFLICT',
          'An active Document with the same file hash already exists in this Matter'
        )
      }

      try {
        const result = transaction
          .update(documents)
          .set({ deletedAt: null, updatedAt: input.event.createdAt })
          .where(and(eq(documents.id, input.documentId), isNotNull(documents.deletedAt)))
          .run()
        if (result.changes !== 1) {
          throw new WorkspaceLifecycleRepositoryError('DOCUMENT_BUSY', 'Document state changed before restore completed')
        }
        transaction.insert(workspaceEvents).values(toEventInsert(input.event)).run()
      } catch (error) {
        // A concurrent insert won the partial unique index between the conflict
        // check and the update; the whole transaction (event included) rolls back.
        if (isUniqueIndexViolation(error)) {
          throw new WorkspaceLifecycleRepositoryError(
            'RESTORE_CONFLICT',
            'An active Document with the same file hash already exists in this Matter',
            { cause: error }
          )
        }
        throw error
      }
      return { changed: true }
    })
  }

  /**
   * One-step replacement in a single transaction: trash the old active
   * Document, insert the replacement as a new active Document recording
   * supersedes_document_id, and append one DOCUMENT_REPLACED event linking
   * both IDs. Nothing is copied from the old Document — no Pages, Blocks,
   * Mentions, Entity assignments, jobs, sanitized artifacts, or AI executions —
   * and any failure rolls the whole replacement back, leaving the old Document
   * active. File inspection and hashing happen before this transaction.
   */
  replaceDocument(input: ReplaceDocumentInput): Document {
    assertWorkspaceEvent(input.event)
    if (
      input.event.type !== 'DOCUMENT_REPLACED' ||
      input.event.supersededDocumentId !== input.supersededDocumentId ||
      input.event.documentId !== input.replacement.id
    ) {
      throw new WorkspaceLifecycleRepositoryError('MATTER_SCOPE_MISMATCH', 'Replacement event does not match its inputs')
    }
    return this.db.transaction((transaction) => {
      const current = transaction
        .select()
        .from(documents)
        .where(eq(documents.id, input.supersededDocumentId))
        .get()
      if (current === undefined) {
        throw new WorkspaceLifecycleRepositoryError('DOCUMENT_NOT_FOUND', 'Document was not found')
      }
      if (current.matterId !== input.replacement.matterId || current.matterId !== input.event.matterId) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_SCOPE_MISMATCH', 'Replacement crossed a Matter boundary')
      }
      if (current.deletedAt !== null) {
        throw new WorkspaceLifecycleRepositoryError('DOCUMENT_UNAVAILABLE', 'Only an active Document can be replaced')
      }
      if (!matterIsAvailable(transaction, current.matterId)) {
        throw new WorkspaceLifecycleRepositoryError('MATTER_UNAVAILABLE', 'Matter is in the trash')
      }
      if (input.event.createdAt < current.updatedAt || input.replacement.createdAt < current.updatedAt) {
        throw new WorkspaceLifecycleRepositoryError('TIMESTAMP_INVALID', 'Replacement timestamp must not move backwards')
      }
      this.assertDocumentIdle(transaction, input.supersededDocumentId)
      // A different active Document with the replacement's hash would violate
      // the partial unique index; failing here keeps the error explicit and
      // rolls back before any state change.
      const conflict = transaction
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.matterId, current.matterId),
            eq(documents.fileHash, input.replacement.fileHash),
            isNull(documents.deletedAt),
            ne(documents.id, input.supersededDocumentId)
          )
        )
        .limit(1)
        .get()
      if (conflict !== undefined) {
        throw new WorkspaceLifecycleRepositoryError(
          'RESTORE_CONFLICT',
          'An active Document with the same file hash already exists in this Matter'
        )
      }

      // Trash the old row first so replacing a Document with the identical
      // file cannot trip the active-only partial unique index mid-transaction.
      const trashed = transaction
        .update(documents)
        .set({ deletedAt: input.event.createdAt, updatedAt: input.event.createdAt })
        .where(and(eq(documents.id, input.supersededDocumentId), isNull(documents.deletedAt)))
        .run()
      if (trashed.changes !== 1) {
        throw new WorkspaceLifecycleRepositoryError('DOCUMENT_BUSY', 'Document state changed before replacement completed')
      }
      const replacement: Document = {
        id: input.replacement.id,
        matterId: input.replacement.matterId,
        fileHash: input.replacement.fileHash,
        mimeType: input.replacement.mimeType,
        parseStatus: input.replacement.parseStatus,
        createdAt: input.replacement.createdAt,
        updatedAt: input.replacement.updatedAt,
        supersedesDocumentId: input.supersededDocumentId
      }
      assertDocument(replacement)
      try {
        transaction
          .insert(documents)
          .values({
            ...input.replacement,
            supersedesDocumentId: input.supersededDocumentId
          })
          .run()
        transaction.insert(workspaceEvents).values(toEventInsert(input.event)).run()
      } catch (error) {
        if (isUniqueIndexViolation(error)) {
          throw new WorkspaceLifecycleRepositoryError(
            'RESTORE_CONFLICT',
            'An active Document with the same file hash already exists in this Matter',
            { cause: error }
          )
        }
        throw error
      }
      return replacement
    })
  }

  /** Dedicated trash read path: deleted Matters and individually trashed Documents. */
  listTrash(): WorkspaceTrashSource {
    const matterRows = this.db
      .select()
      .from(matters)
      .where(eq(matters.status, 'DELETED'))
      .orderBy(desc(matters.updatedAt), asc(matters.id))
      .all()
    const documentRows = this.db
      .select({ document: documents, matterNameCipher: matters.nameCipher })
      .from(documents)
      .innerJoin(matters, eq(matters.id, documents.matterId))
      .where(and(isNotNull(documents.deletedAt), ne(matters.status, 'DELETED')))
      .orderBy(desc(documents.deletedAt), asc(documents.id))
      .all()
    return {
      matters: matterRows.map((row) => ({
        matter: { id: row.id, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt },
        nameCipher: row.nameCipher
      })),
      documents: documentRows.map(({ document: row, matterNameCipher }) => ({
        document: {
          id: row.id,
          matterId: row.matterId,
          fileHash: row.fileHash,
          mimeType: row.mimeType,
          ...(row.pageCount === null ? {} : { pageCount: row.pageCount }),
          ...(row.parserType === null ? {} : { parserType: row.parserType }),
          parseStatus: row.parseStatus,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt as number
        },
        originalNameCipher: row.originalNameCipher,
        matterNameCipher
      }))
    }
  }

  private assertMatterIdle(transaction: Parameters<Parameters<AliasAiDatabase['transaction']>[0]>[0], matterId: string): void {
    // Native PDF parsing runs without a ProcessingJob row; any document in an
    // in-flight stage counts as running work even without a job record.
    const inFlightDocument = transaction
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.matterId, matterId),
          inArray(documents.parseStatus, [...IN_FLIGHT_PARSE_STATUSES])
        )
      )
      .limit(1)
      .get()
    if (inFlightDocument !== undefined) {
      throw new WorkspaceLifecycleRepositoryError('MATTER_BUSY', 'Matter has running processing work')
    }
    const runningJob = transaction
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .innerJoin(documents, eq(documents.id, processingJobs.documentId))
      .where(
        and(
          eq(documents.matterId, matterId),
          inArray(processingJobs.status, ['PENDING', 'RUNNING'])
        )
      )
      .limit(1)
      .get()
    if (runningJob !== undefined) {
      throw new WorkspaceLifecycleRepositoryError('MATTER_BUSY', 'Matter has running processing work')
    }
    const runningExecution = transaction
      .select({ id: aiExecutions.id })
      .from(aiExecutions)
      .where(and(eq(aiExecutions.matterId, matterId), eq(aiExecutions.status, 'RUNNING')))
      .limit(1)
      .get()
    if (runningExecution !== undefined) {
      throw new WorkspaceLifecycleRepositoryError('MATTER_BUSY', 'Matter has a running AI execution')
    }
  }

  private assertDocumentIdle(
    transaction: Parameters<Parameters<AliasAiDatabase['transaction']>[0]>[0],
    documentId: string
  ): void {
    // Native PDF parsing runs without a ProcessingJob row; the in-flight
    // parse status is the only durable signal that parsing work is running.
    const inFlight = transaction
      .select({ parseStatus: documents.parseStatus })
      .from(documents)
      .where(eq(documents.id, documentId))
      .get()
    if (
      inFlight !== undefined &&
      (IN_FLIGHT_PARSE_STATUSES as readonly string[]).includes(inFlight.parseStatus)
    ) {
      throw new WorkspaceLifecycleRepositoryError('DOCUMENT_BUSY', 'Document has running processing work')
    }
    const runningJob = transaction
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(and(eq(processingJobs.documentId, documentId), inArray(processingJobs.status, ['PENDING', 'RUNNING'])))
      .limit(1)
      .get()
    if (runningJob !== undefined) {
      throw new WorkspaceLifecycleRepositoryError('DOCUMENT_BUSY', 'Document has running processing work')
    }
    const runningExecution = transaction
      .select({ id: aiExecutions.id })
      .from(aiExecutions)
      .innerJoin(sanitizedDocuments, eq(sanitizedDocuments.id, aiExecutions.sanitizedDocumentId))
      .where(and(eq(sanitizedDocuments.documentId, documentId), eq(aiExecutions.status, 'RUNNING')))
      .limit(1)
      .get()
    if (runningExecution !== undefined) {
      throw new WorkspaceLifecycleRepositoryError('DOCUMENT_BUSY', 'Document has a running AI execution')
    }
  }
}

/** Parse stages that count as running work even without a ProcessingJob row. */
const IN_FLIGHT_PARSE_STATUSES = ['PARSING', 'DETECTING', 'RESOLVING', 'SANITIZING'] as const

/** Matches better-sqlite3 unique constraint failures on the partial index. */
function isUniqueIndexViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { readonly code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      (error as { readonly code?: unknown }).code === 'SQLITE_CONSTRAINT')
  )
}
