import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { generateUuidV7 } from '@aliasai/crypto'
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
  const documentWorker = resolveDocumentWorker()
  const services: AliasAiServices = {
    matters: new MatterService(new MatterRepository(db), keys),
    importDocs: new DocumentImportService(documents, keys),
    processing: new DocumentProcessingService(
      documents,
      new PythonWorkerDocumentProcessor(
        documentWorker.parserType,
        new PythonWorkerClient({ command: documentWorker.command, args: documentWorker.args })
      ),
      keys,
      Date.now,
      generateUuidV7,
      { enableOcr: documentWorker.enableOcr }
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

/** Marker file identifying the monorepo root. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

/**
 * Walks up from `startDirectory` until it finds the monorepo root (identified
 * by `pnpm-workspace.yaml`), independent of the process cwd. Returns undefined
 * when no marker is present (e.g. a packaged install outside the repo).
 */
function findWorkspaceRoot(startDirectory: string): string | undefined {
  let current = resolve(startDirectory)
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** Resolves the Python command and native worker script; env overrides win. */
export function resolvePythonRuntime(): { command: string; args: string[] } {
  const command = process.env.ALIASAI_PYTHON_COMMAND
  const scriptPath = process.env.ALIASAI_NATIVE_WORKER_PATH
  if (command !== undefined && scriptPath !== undefined) {
    return { command, args: [scriptPath] }
  }
  const workspaceRoot = findWorkspaceRoot(process.cwd())
  const script = scriptPath ?? findWorkerScript(workspaceRoot)
  const python = command ?? resolvePythonCommand(workspaceRoot)
  if (script === undefined) {
    throw new PythonRuntimeError(
      'PYTHON_RUNTIME_UNAVAILABLE',
      'The document parsing worker is not available. Set ALIASAI_PYTHON_COMMAND and ALIASAI_NATIVE_WORKER_PATH.'
    )
  }
  return { command: python, args: [script] }
}

export interface ResolvedDocumentWorker {
  readonly command: string
  readonly args: readonly string[]
  readonly parserType: string
  readonly enableOcr: boolean
}

/**
 * Resolves the document worker for the composition root. When
 * ALIASAI_OCR_WORKER_PATH is set, the OCR worker (render + PaddleOCR for
 * raster pages) is used with OCR enabled; otherwise the native PDF worker.
 */
export function resolveDocumentWorker(): ResolvedDocumentWorker {
  const ocrWorkerPath = process.env.ALIASAI_OCR_WORKER_PATH
  if (ocrWorkerPath === undefined) {
    const runtime = resolvePythonRuntime()
    return { command: runtime.command, args: runtime.args, parserType: 'NATIVE_PDF', enableOcr: false }
  }
  const python = process.env.ALIASAI_PYTHON_COMMAND ?? resolvePythonCommand(findWorkspaceRoot(process.cwd()))
  return { command: python, args: [ocrWorkerPath], parserType: 'OCR_PDF', enableOcr: true }
}

/**
 * Locates the native worker script relative to the workspace root when one can
 * be found; otherwise falls back to cwd-relative candidates. The `../../`
 * prefix covers `apps/desktop` as the process cwd without a workspace marker.
 */
function findWorkerScript(workspaceRoot: string | undefined): string | undefined {
  if (workspaceRoot !== undefined) {
    const anchored = join(workspaceRoot, 'python', 'document_parser', 'native_worker.py')
    if (existsSync(anchored)) return anchored
  }
  return findFirstExisting(
    'python/document_parser/native_worker.py',
    join('..', 'python', 'document_parser', 'native_worker.py'),
    join('..', '..', 'python', 'document_parser', 'native_worker.py')
  )
}

/**
 * Prefers the repository virtual environment anchored to the workspace root;
 * falls back to the system python3 on PATH (clean CI runners only have the
 * latter).
 */
function resolvePythonCommand(workspaceRoot: string | undefined): string {
  if (workspaceRoot !== undefined) {
    const anchored = join(workspaceRoot, '.venv', 'bin', 'python')
    if (existsSync(anchored)) return anchored
  }
  return (
    findFirstExisting(
      '.venv/bin/python',
      join('..', '.venv', 'bin', 'python'),
      join('..', '..', '.venv', 'bin', 'python')
    ) ?? 'python3'
  )
}

function findFirstExisting(...candidates: readonly string[]): string | undefined {
  const found = candidates.find((candidate) => existsSync(candidate))
  return found === undefined ? undefined : resolve(found)
}
