import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateUuidV7 } from '@aliasai/crypto'
import {
  AiExecutionService,
  DocumentAnalysisService,
  DocumentImportService,
  DocumentProcessingService,
  DocumentReplacementService,
  EncryptedAnalysisFailureSink,
  EntityResolutionService,
  EntityService,
  MatterService,
  PrivacyDetectionService,
  PseudonymizationService,
  RehydrationService,
  ReviewOperationService,
  ReviewQueryService,
  SanitizedPreviewService,
  StartupRecoveryService,
  WorkspaceLifecycleService,
  WorkspaceLifecycleError,
  type ApplicationKeys
} from '@aliasai/application'
import {
  AiExecutionRepository,
  AnalysisFailureRepository,
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  ReviewQueryRepository,
  SanitizationRepository,
  StartupRecoveryRepository,
  WorkspaceLifecycleRepository,
  migrateDatabase,
  openDatabase
} from '@aliasai/database'
import { PythonWorkerClient, PythonWorkerDocumentProcessor } from '@aliasai/python-bridge'
import { AiProviderConfigStore, AiProviderManager } from './ai-provider'
import { DocumentAnalysisRunner } from './document-analysis-runner'
import { IpcOperationTracker } from './ipc-operations'
import { SafeStorageKeyStore, type SafeStorage } from './keys'

/** The slice of Electron's app the runtime depends on; injectable for tests. */
export interface AppLike {
  getPath(name: 'userData'): string
  /** True inside a packaged install; enables bundled-resource resolution. */
  readonly isPackaged: boolean
}

export interface AliasAiServices {
  readonly matters: MatterService
  readonly importDocs: DocumentImportService
  readonly processing: DocumentProcessingService
  readonly detection: PrivacyDetectionService
  readonly resolution: EntityResolutionService
  /** Composes parse -> detect -> resolve into one automatic operation. */
  readonly analysis: DocumentAnalysisService
  readonly entityService: EntityService
  readonly sanitization: PseudonymizationService
  readonly rehydration: RehydrationService
  readonly reviewQuery: ReviewQueryService
  readonly reviewOperations: ReviewOperationService
  readonly preview: SanitizedPreviewService
  readonly ai: AiExecutionService
  /** Configurable provider (Mock or OpenAI-compatible) behind the AI service. */
  readonly aiProvider: AiProviderManager
  /** Recoverable trash/restore for Matters and Documents. */
  readonly lifecycle: WorkspaceLifecycleService
  /** One-step Document replacement with explicit version lineage. */
  readonly replacement: DocumentReplacementService
}

export interface AliasAiRuntime {
  readonly keys: ApplicationKeys
  readonly services: AliasAiServices
  /**
   * Process-local scheduler behind import/replace auto-analysis and the
   * document:analyze channel. `drain` before closing resources on graceful
   * shutdown; abrupt exit stays safe via startup recovery.
   */
  readonly analysisRunner: DocumentAnalysisRunner
  /** In-flight IPC operations across the whole handler surface. */
  readonly ipcOperations: IpcOperationTracker
  /** Closes the database connection immediately; registered on process exit. */
  readonly close: () => void
  /**
   * Graceful teardown for paths that do not funnel through before-quit
   * (tests, self-tests): refuses new analysis starts AND new IPC operations,
   * aborts cancellable external work, then awaits registered runs/operations
   * up to a fixed deadline before closing SQLite. Idempotent.
   */
  readonly shutdown: () => Promise<void>
}

/**
 * Composition root: opens and migrates the local database, loads the OS
 * keychain-protected keys, resolves the Python worker, and wires every
 * application service. Awaited before any window or IPC handler exists.
 */
export async function initializeRuntime(app: AppLike, safeStorage: SafeStorage): Promise<AliasAiRuntime> {
  const keys = await new SafeStorageKeyStore(app.getPath('userData'), safeStorage).load()
  const connection = openDatabase(join(app.getPath('userData'), 'aliasai.db'))
  migrateDatabase(connection.db, resolveMigrationsFolder())

  const { sqlite, db } = connection
  new StartupRecoveryService(new StartupRecoveryRepository(db), keys).recover()
  const documents = new DocumentRepository(db)
  const entities = new EntityRepository(db)
  const resolutionRepository = new EntityResolutionRepository(db)
  const sanitizationRepository = new SanitizationRepository(db)
  const rehydration = new RehydrationService(sanitizationRepository, keys)

  const reviewQuery = new ReviewQueryService(
    new ReviewQueryRepository(db),
    documents,
    entities,
    resolutionRepository,
    keys
  )
  // The provider manager loads the persisted selection (Mock by default) and
  // fails closed — instead of silently falling back to Mock — when a stored
  // real-provider configuration cannot be used.
  const aiProvider = new AiProviderManager(new AiProviderConfigStore(app.getPath('userData'), safeStorage))
  await aiProvider.init()
  const packagedResourcesPath = app.isPackaged ? process.resourcesPath : undefined
  const documentWorker = resolveDocumentWorker(packagedResourcesPath)
  const matterRepository = new MatterRepository(db)
  const documentProcessor = new PythonWorkerDocumentProcessor(
    documentWorker.parserType,
    new PythonWorkerClient({ command: documentWorker.command, args: documentWorker.args })
  )
  const processingService = new DocumentProcessingService(
    documents,
    documentProcessor,
    keys,
    Date.now,
    generateUuidV7,
    { enableOcr: documentWorker.enableOcr }
  )
  const detectionService = new PrivacyDetectionService(new PrivacyDetectionRepository(db), keys)
  const resolutionService = new EntityResolutionService(
    resolutionRepository,
    new ProtectedValueRepository(db),
    entities,
    keys
  )
  const analysisService = new DocumentAnalysisService(
    reviewQuery,
    processingService,
    detectionService,
    resolutionService,
    // Any background failure leaves a persisted FAILED state attributed to
    // its stage, so the UI stops showing progress and offers one retry.
    new EncryptedAnalysisFailureSink(new AnalysisFailureRepository(db), keys)
  )
  // Constructed before the services literal: the replacement service needs
  // its pre-commit guard to reference the runner reservation.
  const analysisRunner = new DocumentAnalysisRunner(analysisService, logAnalysisFailure)

  const services: AliasAiServices = {
    matters: new MatterService(matterRepository, keys),
    importDocs: new DocumentImportService(documents, matterRepository, keys),
    processing: processingService,
    detection: detectionService,
    resolution: resolutionService,
    analysis: analysisService,
    entityService: new EntityService(entities, keys),
    sanitization: new PseudonymizationService(sanitizationRepository, keys),
    rehydration,
    reviewQuery,
    reviewOperations: new ReviewOperationService(
      new EntityResolutionService(resolutionRepository, new ProtectedValueRepository(db), entities, keys),
      reviewQuery
    ),
    preview: new SanitizedPreviewService(
      documents,
      new ReviewQueryRepository(db),
      sanitizationRepository,
      new PseudonymizationService(sanitizationRepository, keys),
      rehydration,
      keys
    ),
    ai: new AiExecutionService(new AiExecutionRepository(db), rehydration, aiProvider, keys),
    aiProvider,
    lifecycle: new WorkspaceLifecycleService(
      new WorkspaceLifecycleRepository(db),
      documents,
      matterRepository,
      keys
    ),
    replacement: new DocumentReplacementService(
      new WorkspaceLifecycleRepository(db),
      documents,
      matterRepository,
      keys,
      Date.now,
      generateUuidV7,
      // Authoritative pre-commit guard: runs after the awaited source
      // inspection, immediately before the synchronous replacement
      // transaction — the runner reservation closes the last async window.
      (documentId) => {
        if (analysisRunner.isActive(documentId)) {
          throw new WorkspaceLifecycleError('DOCUMENT_BUSY', 'Document analysis is scheduled or running')
        }
      }
    )
  }

  let closed = false
  const ipcOperations = new IpcOperationTracker()
  const closeDatabase = () => {
    if (closed) return
    closed = true
    process.off('exit', close)
    // Late background starts are refused after close; already-registered runs
    // fail fast against the closed database and their rejections stay observed.
    analysisRunner.close()
    sqlite.close()
  }
  const close = (): void => {
    closeDatabase()
  }
  let shutdownPromise: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      // Intake first, then actively settle the two unbounded external waiters:
      // AbortController-backed AI calls and the persistent Python child. Their
      // rejections flow through the existing stage finalizers while SQLite is
      // still open. A fixed deadline prevents a non-cancellable host dialog or
      // broken external adapter from blocking application exit forever.
      analysisRunner.close()
      ipcOperations.close()
      services.ai.cancelActive()
      documentProcessor.stop()
      await drainWithDeadline([analysisRunner.drain(), ipcOperations.drain()], SHUTDOWN_DRAIN_TIMEOUT_MS)
      closeDatabase()
    })()
    return shutdownPromise
  }
  process.once('exit', close)
  return { keys, services, analysisRunner, ipcOperations, close, shutdown }
}

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000

async function drainWithDeadline(tasks: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(tasks),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  if (timer !== undefined) clearTimeout(timer)
}

/**
 * Background analysis failures are already represented by persisted FAILED
 * state. This observer exists so the rejection is never unhandled; it logs a
 * code only — never messages, values, or paths, which raw errors may carry.
 */
function logAnalysisFailure(documentId: string, error: unknown): void {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'UNKNOWN'
  console.error(`[aliasai] automatic document analysis failed (${documentId.slice(0, 8)}…): ${code}`)
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

/**
 * Locates the Drizzle migrations for the running layout. In the bundled main
 * process (dev `electron .` and packaged installs) they sit next to
 * dist/main/index.cjs; unbundled test runs fall back to the repository's
 * packages/database/drizzle.
 */
function resolveMigrationsFolder(): string {
  const markers = ['meta', '_journal.json']
  const isMigrationRoot = (directory: string): boolean => existsSync(join(directory, ...markers))
  const bundleDirectory = dirname(fileURLToPath(import.meta.url))
  const bundled = join(bundleDirectory, 'drizzle')
  if (isMigrationRoot(bundled)) return bundled
  const workspaceRoot = findWorkspaceRoot(bundleDirectory)
  if (workspaceRoot !== undefined) {
    const source = join(workspaceRoot, 'packages', 'database', 'drizzle')
    if (isMigrationRoot(source)) return source
  }
  throw new Error('Database migrations are missing from this installation')
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

export interface PackagedPythonResources {
  readonly pythonCommand: string
  readonly nativeWorkerPath: string
}

/**
 * Locates the bundled Python runtime and native worker inside a packaged
 * install's resources directory (extraResources: `python-runtime/` and
 * `python-workers/`). Returns undefined when either piece is missing, so an
 * incomplete or tampered bundle fails closed instead of half-resolving.
 */
export function resolvePackagedPythonResources(resourcesPath: string): PackagedPythonResources | undefined {
  const pythonCommand = join(resourcesPath, 'python-runtime', 'bin', 'python3')
  const nativeWorkerPath = join(resourcesPath, 'python-workers', 'document_parser', 'native_worker.py')
  if (!existsSync(pythonCommand) || !existsSync(nativeWorkerPath)) return undefined
  return { pythonCommand, nativeWorkerPath }
}

/**
 * Bundled resources for a packaged install, or undefined in development. A
 * packaged install never falls back to the repository: an incomplete bundle
 * is a broken install and fails closed immediately.
 */
function packagedRuntimeFor(resourcesPath: string): PackagedPythonResources
function packagedRuntimeFor(resourcesPath: undefined): undefined
function packagedRuntimeFor(resourcesPath: string | undefined): PackagedPythonResources | undefined {
  if (resourcesPath === undefined) return undefined
  const packaged = resolvePackagedPythonResources(resourcesPath)
  if (packaged === undefined) {
    throw new PythonRuntimeError(
      'PYTHON_RUNTIME_UNAVAILABLE',
      'The bundled Python runtime is missing or incomplete. Reinstall the application.'
    )
  }
  return packaged
}

/**
 * Resolves the Python command and native worker script. Env overrides win;
 * a packaged install resolves only from its bundled resources (fail-closed
 * when they are incomplete); development falls back to repository workspace
 * discovery.
 */
export function resolvePythonRuntime(packagedResourcesPath?: string): { command: string; args: string[] } {
  const command = process.env.ALIASAI_PYTHON_COMMAND
  const scriptPath = process.env.ALIASAI_NATIVE_WORKER_PATH
  if (command !== undefined && scriptPath !== undefined) {
    return { command, args: [scriptPath] }
  }
  if (packagedResourcesPath !== undefined) {
    const packaged = packagedRuntimeFor(packagedResourcesPath)
    return { command: command ?? packaged.pythonCommand, args: [scriptPath ?? packaged.nativeWorkerPath] }
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
export function resolveDocumentWorker(packagedResourcesPath?: string): ResolvedDocumentWorker {
  const ocrWorkerPath = process.env.ALIASAI_OCR_WORKER_PATH
  if (ocrWorkerPath === undefined) {
    const runtime = resolvePythonRuntime(packagedResourcesPath)
    return { command: runtime.command, args: runtime.args, parserType: 'NATIVE_PDF', enableOcr: false }
  }
  const packaged =
    packagedResourcesPath === undefined ? undefined : packagedRuntimeFor(packagedResourcesPath)
  const python =
    process.env.ALIASAI_PYTHON_COMMAND ??
    packaged?.pythonCommand ??
    resolvePythonCommand(findWorkspaceRoot(process.cwd()))
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
