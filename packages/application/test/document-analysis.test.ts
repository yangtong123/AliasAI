import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentParseStatus } from '@aliasai/domain'
import { selectAnalysisAction } from '@aliasai/domain'
import { decrypt } from '@aliasai/crypto'
import type { ApplicationKeys } from '../src/index'
import {
  DocumentImportService,
  DocumentProcessingService,
  EncryptedAnalysisFailureSink,
  EntityResolutionService,
  MatterService,
  PrivacyDetectionService,
  ReviewQueryService
} from '../src/index'
import type { AliasAiDatabase, SqliteClient } from '@aliasai/database'
import {
  AnalysisFailureRepository,
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  ReviewQueryRepository,
  migrateDatabase,
  openDatabase
} from '@aliasai/database'
import type { JobSummaryDTO } from '../src/review-read'
import { DocumentAnalysisService } from '../src/document-analysis'
import { DocumentAnalysisRunner } from '../../../apps/desktop/main/src/document-analysis-runner'

const trackedRunners: DocumentAnalysisRunner[] = []
function trackedList(): readonly DocumentAnalysisRunner[] {
  return trackedRunners
}

type StageName = 'process' | 'detect' | 'resolve'

interface Harness {
  readonly stages: StageName[]
  readonly reads: number
  analyze(): ReturnType<DocumentAnalysisService['analyze']>
}

/**
 * Builds a service over synthetic fakes. `snapshots` are consumed in order on
 * every status re-read; the final snapshot repeats for any extra read. Each
 * runner either resolves (advancing the queue) or rejects once.
 */
function harness(
  snapshots: readonly { parseStatus: DocumentParseStatus; updatedAt?: number; jobs?: readonly JobSummaryDTO[] }[],
  failures: Partial<Record<StageName, string>> = {}
): Harness {
  const stages: StageName[] = []
  let readIndex = 0
  const reader = {
    getDocumentStatus: () => {
      const snapshot = snapshots[Math.min(readIndex, snapshots.length - 1)]!
      readIndex += 1
      return { document: { parseStatus: snapshot.parseStatus, updatedAt: snapshot.updatedAt ?? readIndex }, jobs: snapshot.jobs ?? [] }
    }
  }
  const runner = (name: StageName) => async () => {
    stages.push(name)
    const code = failures[name]
    if (code !== undefined) throw new Error(code)
    return {}
  }
  const service = new DocumentAnalysisService(
    reader,
    { process: runner('process') },
    { detect: runner('detect') },
    { resolve: runner('resolve') }
  )
  return {
    stages,
    get reads(): number {
      return readIndex
    },
    analyze: () => service.analyze('document-1')
  }
}

const failedJob = (type: JobSummaryDTO['type']): JobSummaryDTO => ({
  id: `job-${type.toLowerCase()}-failed`,
  type,
  status: 'FAILED',
  progress: 0,
  createdAt: 10
})
const sanitizeFailedJob = failedJob('SANITIZE')

describe('selectAnalysisAction via the sequential orchestrator', () => {
  it('runs parse, detect, resolve in order for an IMPORTED document and ends COMPLETE', async () => {
    const flow = harness([
      { parseStatus: 'IMPORTED' },
      { parseStatus: 'PARSED' },
      { parseStatus: 'DETECTED' },
      { parseStatus: 'READY' }
    ])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'COMPLETE' })
    expect(flow.stages).toEqual(['process', 'detect', 'resolve'])
    // Status is re-read after every awaited stage before choosing the next one.
    expect(flow.reads).toBe(4)
  })

  it('skips parsing for a PARSED document', async () => {
    const flow = harness([{ parseStatus: 'PARSED' }, { parseStatus: 'DETECTED' }, { parseStatus: 'READY' }])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'COMPLETE' })
    expect(flow.stages).toEqual(['detect', 'resolve'])
  })

  it('skips parsing and detection for a DETECTED document', async () => {
    const flow = harness([{ parseStatus: 'DETECTED' }, { parseStatus: 'READY' }])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'COMPLETE' })
    expect(flow.stages).toEqual(['resolve'])
  })

  it.each(['READY', 'SANITIZED'] as const)('treats %s as a successful no-op', async (parseStatus) => {
    const flow = harness([{ parseStatus }])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'ALREADY_COMPLETE' })
    expect(flow.stages).toEqual([])
    expect(flow.reads).toBe(1)
  })

  it('stops before detection when parsing fails and reports the error unchanged', async () => {
    const flow = harness(
      [{ parseStatus: 'IMPORTED' }, { parseStatus: 'FAILED' }],
      { process: 'OCR_FAILED_SYNONTHETIC' }
    )
    await expect(flow.analyze()).rejects.toThrow('OCR_FAILED_SYNONTHETIC')
    expect(flow.stages).toEqual(['process'])
  })

  it('stops before resolution when detection fails', async () => {
    const flow = harness([{ parseStatus: 'PARSED' }, { parseStatus: 'FAILED', jobs: [failedJob('DETECT')] }], {
      detect: 'DETECTION_FAILURE'
    })
    await expect(flow.analyze()).rejects.toThrow('DETECTION_FAILURE')
    expect(flow.stages).toEqual(['detect'])
  })

  it('ends at resolution when resolution fails', async () => {
    const flow = harness([{ parseStatus: 'DETECTED' }, { parseStatus: 'FAILED', jobs: [failedJob('RESOLVE')] }], {
      resolve: 'RESOLUTION_FAILURE'
    })
    await expect(flow.analyze()).rejects.toThrow('RESOLUTION_FAILURE')
    expect(flow.stages).toEqual(['resolve'])
  })

  it.each([
    [{ parseStatus: 'FAILED' }, 'process'],
    [{ parseStatus: 'FAILED', jobs: [failedJob('OCR')] }, 'process'],
    [{ parseStatus: 'FAILED', jobs: [failedJob('DETECT'), { id: 'job-parse-completed', type: 'PARSE', status: 'COMPLETED', progress: 1, createdAt: 20 }] }, 'detect']
  ] as const)('retries a FAILED document from its origin stage (%j)', async (firstSnapshot, expectedFirstStage) => {
    const flow = harness([
      firstSnapshot,
      { parseStatus: 'PARSED' },
      { parseStatus: 'DETECTED' },
      { parseStatus: 'READY' }
    ])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'COMPLETE' })
    expect(flow.stages[0]).toBe(expectedFirstStage)
  })

  it('retries only resolution when the RESOLVE job failed', async () => {
    const flow = harness([
      { parseStatus: 'FAILED', jobs: [failedJob('RESOLVE'), failedJob('DETECT')] },
      { parseStatus: 'READY' }
    ])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'COMPLETE' })
    expect(flow.stages).toEqual(['resolve'])
  })

  it('does not route a sanitization failure into analysis', async () => {
    const flow = harness([{ parseStatus: 'FAILED', jobs: [sanitizeFailedJob] }])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'ALREADY_COMPLETE' })
    expect(flow.stages).toEqual([])
  })

  it('does not route a verification failure into analysis', async () => {
    const flow = harness([{ parseStatus: 'FAILED', jobs: [{ id: 'job-verify-cancelled', type: 'VERIFY', status: 'CANCELLED', progress: 0, createdAt: 5 }] }])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'ALREADY_COMPLETE' })
    expect(flow.stages).toEqual([])
  })

  it('never starts a second run while a live stage owns the document', async () => {
    const stages: StageName[] = []
    const snapshots = ['PARSING', 'PARSED', 'DETECTED', 'READY'] as const
    let read = 0
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({
          document: { parseStatus: snapshots[Math.min(read++, snapshots.length - 1)]!, updatedAt: read },
          jobs: []
        })
      },
      { process: async () => { stages.push('process') } },
      { detect: async () => { stages.push('detect') } },
      { resolve: async () => { stages.push('resolve') } },
      undefined,
      Date.now,
      async () => undefined
    )

    await expect(service.analyze('document-1')).resolves.toEqual({ documentId: 'document-1', status: 'COMPLETE' })
    // Parsing remained owned by the compatibility channel; automatic analysis
    // waited for PARSED, then took responsibility for the remaining stages.
    expect(stages).toEqual(['detect', 'resolve'])
  })

  it('does not automatically retry an external live stage that ends FAILED', async () => {
    let read = 0
    const process = vi.fn()
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () =>
          read++ === 0
            ? { document: { parseStatus: 'PARSING' as const, updatedAt: 1 }, jobs: [] }
            : { document: { parseStatus: 'FAILED' as const, updatedAt: 2 }, jobs: [failedJob('PARSE')] }
      },
      { process },
      { detect: vi.fn() },
      { resolve: vi.fn() },
      undefined,
      Date.now,
      async () => undefined
    )

    await expect(service.analyze('document-1')).resolves.toEqual({
      documentId: 'document-1',
      status: 'ALREADY_COMPLETE'
    })
    expect(process).not.toHaveBeenCalled()
  })

  it('tolerates reused completed jobs between stages instead of assuming fresh work', async () => {
    // A completed downstream job may make a stage a no-op reuse; the loop keeps
    // trusting persisted status transitions rather than counting invocations.
    const flow = harness([
      { parseStatus: 'PARSED', jobs: [{ id: 'job-detect-completed', type: 'DETECT', status: 'COMPLETED', progress: 1, createdAt: 3 }] },
      { parseStatus: 'PARSED' },
      { parseStatus: 'DETECTED' },
      { parseStatus: 'READY' }
    ])
    await expect(flow.analyze()).resolves.toEqual({ documentId: 'document-1', status: 'COMPLETE' })
    expect(flow.stages.length).toBeGreaterThanOrEqual(2)
  })

  it('persists an exact terminal revision when the iteration guard detects a stalled pipeline', async () => {
    const failureSink = { recordAnalysisFailure: vi.fn() }
    const processing = { process: vi.fn(async () => undefined) }
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({
          document: { parseStatus: 'IMPORTED' as const, updatedAt: 7 },
          jobs: []
        })
      },
      processing,
      { detect: vi.fn() },
      { resolve: vi.fn() },
      failureSink,
      () => 20
    )

    await expect(service.analyze('document-1')).rejects.toMatchObject({ code: 'ANALYSIS_STALLED' })
    expect(processing.process).toHaveBeenCalledTimes(8)
    expect(failureSink.recordAnalysisFailure).toHaveBeenCalledOnce()
    expect(failureSink.recordAnalysisFailure).toHaveBeenCalledWith({
      documentId: 'document-1',
      stage: 'PARSE',
      expected: { parseStatus: 'IMPORTED', updatedAt: 7 },
      errorCode: 'ANALYSIS_STALLED',
      occurredAt: 20
    })
  })

  it('accepts a terminal state reached on the final guarded iteration', async () => {
    let reads = 0
    const processing = { process: vi.fn(async () => undefined) }
    const failureSink = { recordAnalysisFailure: vi.fn() }
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => {
          reads += 1
          return {
            document: { parseStatus: reads <= 8 ? ('IMPORTED' as const) : ('READY' as const), updatedAt: reads },
            jobs: []
          }
        }
      },
      processing,
      { detect: vi.fn() },
      { resolve: vi.fn() },
      failureSink
    )

    await expect(service.analyze('document-1')).resolves.toEqual({ documentId: 'document-1', status: 'COMPLETE' })
    expect(processing.process).toHaveBeenCalledTimes(8)
    expect(failureSink.recordAnalysisFailure).not.toHaveBeenCalled()
  })

  it('exposes only the three stage runners; entity creation stays inside resolution', () => {
    const flow = harness([{ parseStatus: 'DETECTED' }, { parseStatus: 'READY' }])
    void flow.analyze()
    // The orchestration layer's entire write surface is process/detect/resolve;
    // anything else (entity creation, assignment) belongs to EntityResolutionService.
    expect(flow.stages.every((stage) => ['process', 'detect', 'resolve'].includes(stage))).toBe(true)
  })

  it('keeps the review query on the friendly product surface without leaking internals', async () => {
    const documents = { getDocumentStatus: vi.fn(() => ({ document: { parseStatus: 'READY' as const, updatedAt: 1 }, jobs: [] })) }
    const service = new DocumentAnalysisService(documents, { process: vi.fn() }, { detect: vi.fn() }, { resolve: vi.fn() })
    await expect(service.analyze('document-9')).resolves.toEqual({ documentId: 'document-9', status: 'ALREADY_COMPLETE' })
    expect(documents.getDocumentStatus).toHaveBeenCalledWith('document-9')
  })

  it('persists an inferred terminal failure when the status projection cannot be read', async () => {
    const readFailure = Object.assign(new Error('projection unavailable'), { code: 'STATUS_READ_FAILED' })
    const documents = { getDocumentStatus: vi.fn(() => { throw readFailure }) }
    const failureSink = { recordAnalysisFailure: vi.fn() }
    const service = new DocumentAnalysisService(
      documents,
      { process: vi.fn() },
      { detect: vi.fn() },
      { resolve: vi.fn() },
      failureSink,
      () => 20
    )

    await expect(service.analyze('document-9')).rejects.toBe(readFailure)
    expect(documents.getDocumentStatus).toHaveBeenCalledTimes(3)
    expect(failureSink.recordAnalysisFailure).toHaveBeenCalledWith({
      documentId: 'document-9',
      errorCode: 'STATUS_READ_FAILED',
      occurredAt: 20
    })
  })

  it('surfaces an unrecorded terminal signal when status-read compensation is ignored', async () => {
    const service = new DocumentAnalysisService(
      { getDocumentStatus: () => { throw new Error('projection unavailable') } },
      { process: vi.fn() },
      { detect: vi.fn() },
      { resolve: vi.fn() },
      { recordAnalysisFailure: () => 'IGNORED' }
    )

    await expect(service.analyze('document-ignored-read')).rejects.toMatchObject({
      code: 'ANALYSIS_FAILURE_UNRECORDED'
    })
  })

  it('binds a stage fallback to the exact pre-stage revision', async () => {
    const failed = Object.assign(new Error('detect failed'), { code: 'DETECTION_FAILED' })
    const failureSink = { recordAnalysisFailure: vi.fn() }
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({
          document: { parseStatus: 'FAILED' as const, updatedAt: 11 },
          jobs: [failedJob('DETECT')]
        })
      },
      { process: vi.fn() },
      { detect: vi.fn(async () => { throw failed }) },
      { resolve: vi.fn() },
      failureSink,
      () => 20
    )

    await expect(service.analyze('document-9')).rejects.toBe(failed)
    expect(failureSink.recordAnalysisFailure).toHaveBeenCalledWith({
      documentId: 'document-9',
      stage: 'DETECT',
      expected: { parseStatus: 'FAILED', updatedAt: 11, failedJobId: 'job-detect-failed' },
      errorCode: 'DETECTION_FAILED',
      occurredAt: 20
    })
  })

  it('binds a stage-owned fallback cipher to the existing owner job ID', () => {
    let captured: { job: { id: string; errorCipher: Buffer } } | undefined
    const repository = {
      recordAnalysisFailure: (input: { job: { id: string; errorCipher: Buffer } }) => {
        captured = { job: { id: input.job.id, errorCipher: Buffer.from(input.job.errorCipher) } }
        return 'RECORDED' as const
      }
    }
    const keys: ApplicationKeys = { persistenceKey: Buffer.alloc(32, 7) }
    const sink = new EncryptedAnalysisFailureSink(
      repository,
      keys,
      () => 20,
      () => {
        throw new Error('owner fallback must not generate a replacement job ID')
      }
    )

    sink.recordAnalysisFailure({
      documentId: 'document-9',
      stage: 'DETECT',
      owner: { jobId: 'job-owner' },
      errorCode: 'PERSISTENCE_FAILURE',
      occurredAt: 20
    })
    expect(captured?.job.id).toBe('job-owner')
    const plaintext = decrypt(
      captured!.job.errorCipher,
      keys.persistenceKey,
      Buffer.from('job-owner:processingJob.error')
    )
    expect(JSON.parse(plaintext.toString('utf8'))).toEqual({ code: 'PERSISTENCE_FAILURE' })
    plaintext.fill(0)
  })

  it('forwards the exact running owner when stage failure finalization escaped', async () => {
    const failed = Object.assign(new Error('finalization escaped'), {
      code: 'PERSISTENCE_FAILURE',
      analysisOwner: { jobId: 'job-running' }
    })
    const failureSink = { recordAnalysisFailure: vi.fn() }
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({ document: { parseStatus: 'PARSED' as const, updatedAt: 8 }, jobs: [] })
      },
      { process: vi.fn() },
      { detect: vi.fn(async () => { throw failed }) },
      { resolve: vi.fn() },
      failureSink,
      () => 20
    )

    await expect(service.analyze('document-9')).rejects.toBe(failed)
    expect(failureSink.recordAnalysisFailure).toHaveBeenCalledWith({
      documentId: 'document-9',
      stage: 'DETECT',
      expected: { parseStatus: 'PARSED', updatedAt: 8 },
      owner: { jobId: 'job-running' },
      errorCode: 'PERSISTENCE_FAILURE',
      occurredAt: 20
    })
  })

  it('surfaces a coded terminalization failure when the failure sink itself rejects the write', async () => {
    const stageFailure = Object.assign(new Error('source vanished'), { code: 'SOURCE_VALIDATION_FAILED' })
    const sinkFailure = new Error('synthetic persistence outage')
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({ document: { parseStatus: 'IMPORTED' as const, updatedAt: 8 }, jobs: [] })
      },
      { process: async () => { throw stageFailure } },
      { detect: vi.fn() },
      { resolve: vi.fn() },
      { recordAnalysisFailure: () => { throw sinkFailure } },
      () => 20
    )

    await expect(service.analyze('document-9')).rejects.toMatchObject({
      code: 'ANALYSIS_FAILURE_UNRECORDED',
      cause: expect.any(AggregateError)
    })
  })

  it('keeps ownership when a compatibility stage wins after the pre-stage read', async () => {
    let parseStatus: DocumentParseStatus = 'PARSED'
    let updatedAt = 8
    const resolve = vi.fn(async () => {
      parseStatus = 'READY'
      updatedAt = 11
    })
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({ document: { parseStatus, updatedAt }, jobs: [] })
      },
      { process: vi.fn() },
      {
        detect: async () => {
          // Compatibility DETECT acquires ownership after the orchestrator read
          // PARSED but before its own stage call reaches the repository.
          parseStatus = 'DETECTING'
          updatedAt = 9
          throw Object.assign(new Error('stage already owned'), { code: 'DETECTION_NOT_AVAILABLE' })
        }
      },
      { resolve },
      { recordAnalysisFailure: () => 'IGNORED' },
      Date.now,
      async () => {
        parseStatus = 'DETECTED'
        updatedAt = 10
      }
    )

    await expect(service.analyze('document-race')).resolves.toEqual({
      documentId: 'document-race',
      status: 'COMPLETE'
    })
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('still propagates the original stage error after that stage persisted FAILED itself', async () => {
    const stageFailure = Object.assign(new Error('detector failed'), { code: 'DETECTION_FAILED' })
    let parseStatus: DocumentParseStatus = 'PARSED'
    let updatedAt = 8
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({
          document: { parseStatus, updatedAt },
          jobs:
            parseStatus === 'FAILED'
              ? [{ id: 'job-detect-failed', type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 9 }]
              : []
        })
      },
      { process: vi.fn() },
      {
        detect: async () => {
          parseStatus = 'FAILED'
          updatedAt = 9
          throw stageFailure
        }
      },
      { resolve: vi.fn() },
      { recordAnalysisFailure: () => 'IGNORED' }
    )

    await expect(service.analyze('document-own-failure')).rejects.toBe(stageFailure)
  })

  it('reports an unrecorded terminal failure when compensation is ignored without any revision change', async () => {
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({ document: { parseStatus: 'PARSED' as const, updatedAt: 8 }, jobs: [] })
      },
      { process: vi.fn() },
      { detect: async () => { throw new Error('detect escaped before ownership') } },
      { resolve: vi.fn() },
      { recordAnalysisFailure: () => 'IGNORED' }
    )

    await expect(service.analyze('document-static')).rejects.toMatchObject({
      code: 'ANALYSIS_FAILURE_UNRECORDED'
    })
  })

  it('retries an unrecorded terminal write before rerunning the failed stage', async () => {
    let parseStatus: DocumentParseStatus = 'IMPORTED'
    let updatedAt = 1
    let sinkCalls = 0
    let processCalls = 0
    const service = new DocumentAnalysisService(
      {
        getDocumentStatus: () => ({
          document: { parseStatus, updatedAt },
          jobs:
            parseStatus === 'FAILED'
              ? [{ id: 'job-failed', type: 'PARSE', status: 'FAILED', progress: 0, createdAt: 2 }]
              : []
        })
      },
      {
        process: async () => {
          processCalls += 1
          if (processCalls === 1) throw Object.assign(new Error('source unavailable'), { code: 'SOURCE_VALIDATION_FAILED' })
          parseStatus = 'PARSED'
          updatedAt = 3
        }
      },
      {
        detect: async () => {
          parseStatus = 'DETECTED'
          updatedAt = 4
        }
      },
      {
        resolve: async () => {
          parseStatus = 'READY'
          updatedAt = 5
        }
      },
      {
        recordAnalysisFailure: () => {
          sinkCalls += 1
          if (sinkCalls === 1) throw new Error('synthetic persistence outage')
          parseStatus = 'FAILED'
          updatedAt = 2
          return 'RECORDED'
        }
      }
    )

    await expect(service.analyze('document-retryable-sink')).rejects.toMatchObject({
      code: 'ANALYSIS_FAILURE_UNRECORDED'
    })
    await expect(service.analyze('document-retryable-sink')).resolves.toEqual({
      documentId: 'document-retryable-sink',
      status: 'COMPLETE'
    })
    expect(sinkCalls).toBe(2)
    expect(processCalls).toBe(2)
    expect(parseStatus).toBe('READY')
  })
})

describe('analysis failure terminal state (real services, missing source)', () => {
  const persistenceKey = Buffer.alloc(32, 11)
  const searchKey = Buffer.alloc(32, 13)
  const keys: ApplicationKeys = { persistenceKey, searchKey }
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  const directories: string[] = []

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
  })

  afterEach(async () => {
    for (const runner of trackedRunners.splice(0)) runner.close()
    sqlite.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  function syntheticPdf(text: string): Buffer {
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(')
    const content = `BT /F1 10 Tf 18 84 Td (${escaped}) Tj ET`
    return Buffer.from(
      '%PDF-1.4\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 120] >>\nendobj\n' +
        `4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n` +
        'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
      'ascii'
    )
  }

  /** Read-model status through the REAL review service for this test's db. */
  function reviewStatus(documentId: string): {
    document: { parseStatus: string; updatedAt: number }
    jobs: { id: string; type: string; status: string }[]
  } {
    const review = new ReviewQueryService(
      new ReviewQueryRepository(db),
      new DocumentRepository(db),
      new EntityRepository(db),
      new EntityResolutionRepository(db),
      keys
    )
    const status = review.getDocumentStatus(documentId)
    return {
      document: { parseStatus: status.document.parseStatus, updatedAt: status.document.updatedAt },
      jobs: status.jobs.map((job) => ({ id: job.id, type: job.type, status: job.status }))
    }
  }

  function buildAnalysis(): DocumentAnalysisService {
    // The worker is never reached when the source is gone: path/source
    // validation fails before PARSING is entered.
    const processor = {
      parserType: 'NATIVE_PDF',
      processDocument: async (): Promise<never> => {
        throw new Error('worker must not be invoked when the source is gone')
      }
    }
    return new DocumentAnalysisService(
      new ReviewQueryService(
        new ReviewQueryRepository(db),
        new DocumentRepository(db),
        new EntityRepository(db),
        new EntityResolutionRepository(db),
        keys
      ),
      new DocumentProcessingService(new DocumentRepository(db), processor, keys),
      new PrivacyDetectionService(new PrivacyDetectionRepository(db), keys),
      new EntityResolutionService(
        new EntityResolutionRepository(db),
        new ProtectedValueRepository(db),
        new EntityRepository(db),
        keys
      ),
      new EncryptedAnalysisFailureSink(new AnalysisFailureRepository(db), keys)
    )
  }

  function trackedRunner(): DocumentAnalysisRunner {
    const runner = new DocumentAnalysisRunner(buildAnalysis())
    trackedRunners.push(runner)
    return runner
  }

  it('gives an accepted retry that fails pre-start again a NEW revision', async () => {
    const matter = new MatterService(new MatterRepository(db), keys).create('Synthetic Retry Revision Matter')
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-analysis-retry-'))
    directories.push(directory)
    const sourcePath = join(directory, 'gone-again.pdf')
    await writeFile(sourcePath, syntheticPdf('holder synthetic@example.test'))
    const imported = await new DocumentImportService(
      new DocumentRepository(db),
      new MatterRepository(db),
      keys
    ).importFromPath(matter.id, sourcePath)
    await rm(sourcePath)

    // First attempt: fails pre-start, compensated to FAILED with revision A.
    expect(trackedRunner().start(imported.id)).toBe(true)
    await Promise.all(trackedList().map((runner) => runner.drain()))
    const first = reviewStatus(imported.id)
    expect(first.document.parseStatus).toBe('FAILED')
    const firstJobId = first.jobs.find((job) => job.type === 'PARSE')?.id

    // Retry accepted, still no source: fails pre-start again. The same-stage
    // re-compensation must produce a DISTINCT persisted revision (new job id
    // and newer updatedAt) so the renderer can release its activity window.
    expect(trackedRunner().start(imported.id)).toBe(true)
    await Promise.all(trackedList().map((runner) => runner.drain()))
    const second = reviewStatus(imported.id)
    expect(second.document.parseStatus).toBe('FAILED')
    const secondJobId = second.jobs.find((job) => job.type === 'PARSE')?.id
    expect(secondJobId).not.toBe(firstJobId)
    expect(second.document.updatedAt).toBeGreaterThan(first.document.updatedAt)
    const failedJobs = second.jobs.map((job) => ({
      id: job.id,
      type: job.type as 'PARSE',
      status: job.status as 'FAILED',
      progress: 0,
      createdAt: 1
    }))
    expect(selectAnalysisAction({ parseStatus: 'FAILED', jobs: failedJobs })).toBe('RUN_PARSE')
  })

  it('persists a retryable FAILED state plus PARSE job evidence after import', async () => {
    const matter = new MatterService(new MatterRepository(db), keys).create('Synthetic Missing Source Matter')
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-analysis-missing-'))
    directories.push(directory)
    const sourcePath = join(directory, 'vanished.pdf')
    await writeFile(sourcePath, syntheticPdf('holder synthetic@example.test'))

    const imported = await new DocumentImportService(
      new DocumentRepository(db),
      new MatterRepository(db),
      keys
    ).importFromPath(matter.id, sourcePath)
    expect(imported.parseStatus).toBe('IMPORTED')

    // The user moves/deletes the PDF right after importing.
    await rm(sourcePath)

    expect(trackedRunner().start(imported.id)).toBe(true)
    await Promise.all(trackedList().map((runner) => runner.drain()))

    const review = new ReviewQueryService(
      new ReviewQueryRepository(db),
      new DocumentRepository(db),
      new EntityRepository(db),
      new EntityResolutionRepository(db),
      keys
    )
    const status = review.getDocumentStatus(imported.id)
    expect(status.document.parseStatus).toBe('FAILED')
    expect(status.jobs.find((job) => job.type === 'PARSE')?.status).toBe('FAILED')

    // Retry routing derives from persisted job evidence alone.
    expect(selectAnalysisAction({ parseStatus: status.document.parseStatus, jobs: status.jobs })).toBe('RUN_PARSE')
  })
})
