import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DocumentImportService,
  DocumentProcessingService,
  EntityResolutionService,
  EntityService,
  MatterService,
  PrivacyDetectionService,
  PseudonymizationService,
  RehydrationService,
  ReviewOperationService,
  ReviewQueryService,
  SanitizedPreviewService,
  type ApplicationKeys
} from '@aliasai/application'
import {
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  ReviewQueryRepository,
  SanitizationRepository,
  migrateDatabase,
  openDatabase
} from '@aliasai/database'
import { PythonWorkerClient, PythonWorkerDocumentProcessor } from '@aliasai/python-bridge'
import { SafeStorageKeyStore, type SafeStorage } from './keys'

/** The slice of Electron's app the runtime depends on; injectable for tests. */
export interface AppLike {
  getPath(name: 'userData'): string
}

export interface AliasAiServices {
  readonly matters: MatterService
  readonly importDocs: DocumentImportService
  readonly processing: DocumentProcessingService
  readonly detection: PrivacyDetectionService
  readonly resolution: EntityResolutionService
  readonly entityService: EntityService
  readonly sanitization: PseudonymizationService
  readonly rehydration: RehydrationService
  readonly reviewQuery: ReviewQueryService
  readonly reviewOperations: ReviewOperationService
  readonly preview: SanitizedPreviewService
}

export interface AliasAiRuntime {
  readonly keys: ApplicationKeys
  readonly services: AliasAiServices
  /** Closes the database connection; registered on process exit. */
  readonly close: () => void
}

/**
 * Composition root: opens and migrates the local database, loads the OS
 * keychain-protected keys, resolves the Python worker, and wires every
 * application service. Awaited before any window or IPC handler exists.
 */
export async function initializeRuntime(app: AppLike, safeStorage: SafeStorage): Promise<AliasAiRuntime> {
  const keys = await new SafeStorageKeyStore(app.getPath('userData'), safeStorage).load()
  const connection = openDatabase(join(app.getPath('userData'), 'aliasai.db'))
  migrateDatabase(connection.db)

  const { sqlite, db } = connection
  const documents = new DocumentRepository(db)
  const entities = new EntityRepository(db)
  const resolutionRepository = new EntityResolutionRepository(db)
  const sanitizationRepository = new SanitizationRepository(db)

  const reviewQuery = new ReviewQueryService(
    new ReviewQueryRepository(db),
    documents,
    entities,
    resolutionRepository,
    keys
  )
  const services: AliasAiServices = {
    matters: new MatterService(new MatterRepository(db), keys),
    importDocs: new DocumentImportService(documents, keys),
    processing: new DocumentProcessingService(
      documents,
      new PythonWorkerDocumentProcessor('NATIVE_PDF', new PythonWorkerClient(resolvePythonRuntime())),
      keys
    ),
    detection: new PrivacyDetectionService(new PrivacyDetectionRepository(db), keys),
    resolution: new EntityResolutionService(
      resolutionRepository,
      new ProtectedValueRepository(db),
      entities,
      keys
    ),
    entityService: new EntityService(entities, keys),
    sanitization: new PseudonymizationService(sanitizationRepository, keys),
    rehydration: new RehydrationService(sanitizationRepository, keys),
    reviewQuery,
    reviewOperations: new ReviewOperationService(
      new EntityResolutionService(resolutionRepository, new ProtectedValueRepository(db), entities, keys),
      new EntityService(entities, keys),
      reviewQuery
    ),
    preview: new SanitizedPreviewService(
      documents,
      new ReviewQueryRepository(db),
      sanitizationRepository,
      new PseudonymizationService(sanitizationRepository, keys),
      new RehydrationService(sanitizationRepository, keys),
      keys
    )
  }

  const close = () => sqlite.close()
  process.on('exit', close)
  return { keys, services, close }
}

export class PythonRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'PythonRuntimeError'
  }
}

/** Resolves the Python command and native worker script; env overrides win. */
export function resolvePythonRuntime(): { command: string; args: string[] } {
  const command = process.env.ALIASAI_PYTHON_COMMAND
  const scriptPath = process.env.ALIASAI_NATIVE_WORKER_PATH
  if (command !== undefined && scriptPath !== undefined) {
    return { command, args: [scriptPath] }
  }
  const script = scriptPath ?? findFirstExisting(
    'python/document_parser/native_worker.py',
    join('..', 'python', 'document_parser', 'native_worker.py')
  )
  const python = command ?? findFirstExisting('.venv/bin/python', join('..', '.venv', 'bin', 'python'))
  if (script === undefined || python === undefined) {
    throw new PythonRuntimeError(
      'PYTHON_RUNTIME_UNAVAILABLE',
      'The document parsing worker is not available. Set ALIASAI_PYTHON_COMMAND and ALIASAI_NATIVE_WORKER_PATH.'
    )
  }
  return { command: python, args: [script] }
}

function findFirstExisting(...candidates: readonly string[]): string | undefined {
  const found = candidates.find((candidate) => existsSync(candidate))
  return found === undefined ? undefined : resolve(found)
}
