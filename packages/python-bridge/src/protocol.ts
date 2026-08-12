import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const

const envelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.string(),
  jobId: z.string().min(1)
})

export const normalizedBBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1)
  })
  .superRefine((bbox, context) => {
    if (bbox.x + bbox.width > 1) {
      context.addIssue({ code: 'custom', path: ['width'], message: 'bbox.x + bbox.width must not exceed 1' })
    }
    if (bbox.y + bbox.height > 1) {
      context.addIssue({ code: 'custom', path: ['height'], message: 'bbox.y + bbox.height must not exceed 1' })
    }
  })

const processDocumentOptionsSchema = z
  .object({
    preferNativeText: z.boolean(),
    enableOcr: z.boolean(),
    enableLayoutAnalysis: z.boolean(),
    pageStart: z.number().int().min(1).optional(),
    pageEnd: z.number().int().min(1).nullable()
  })
  .superRefine((options, context) => {
    const pageStart = options.pageStart ?? 1
    if (options.pageEnd !== null && options.pageEnd < pageStart) {
      context.addIssue({
        code: 'custom',
        path: ['pageEnd'],
        message: 'pageEnd must be greater than or equal to pageStart'
      })
    }
  })

export const processDocumentRequestSchema = envelopeSchema.extend({
  type: z.literal('process_document'),
  documentId: z.string().min(1),
  filePath: z.string().min(1),
  options: processDocumentOptionsSchema
})

export const cancelJobRequestSchema = envelopeSchema.extend({
  type: z.literal('cancel_job')
})

export const workerRequestSchema = z.discriminatedUnion('type', [processDocumentRequestSchema, cancelJobRequestSchema])

const pageSchema = z.object({
  pageNo: z.number().int().min(1),
  originalWidth: z.number().positive(),
  originalHeight: z.number().positive(),
  rotation: z.number().int(),
  sourceType: z.enum(['NATIVE', 'RASTER', 'MIXED']),
  blocks: z.array(
    z.object({
      localId: z.string().min(1),
      blockType: z.enum(['TEXT', 'TABLE', 'IMAGE']),
      text: z.string(),
      bbox: normalizedBBoxSchema,
      confidence: z.number().min(0).max(1).optional(),
      source: z.enum(['NATIVE', 'OCR']),
      readingOrder: z.number().int().min(0)
    })
  )
})

export const workerEventSchema = z.discriminatedUnion('type', [
  envelopeSchema.extend({ type: z.literal('started'), documentId: z.string().min(1) }),
  envelopeSchema.extend({
    type: z.literal('progress'),
    documentId: z.string().min(1),
    stage: z.enum(['INSPECT', 'NATIVE_PARSE', 'RENDER', 'PREPROCESS', 'OCR', 'LAYOUT', 'FINALIZE']),
    completed: z.number().int().min(0),
    total: z.number().int().positive(),
    pageNo: z.number().int().min(1).optional()
  }),
  envelopeSchema.extend({ type: z.literal('page_result'), documentId: z.string().min(1), page: pageSchema }),
  envelopeSchema.extend({
    type: z.literal('completed'),
    documentId: z.string().min(1),
    pageCount: z.number().int().min(0),
    processedPages: z.number().int().min(0)
  }),
  envelopeSchema.extend({
    type: z.literal('cancelled'),
    documentId: z.string().min(1),
    lastCompletedPage: z.number().int().min(0)
  }),
  envelopeSchema.extend({
    type: z.literal('error'),
    documentId: z.string().min(1),
    code: z.enum([
      'UNSUPPORTED_DOCUMENT',
      'INVALID_REQUEST',
      'FILE_NOT_FOUND',
      'PDF_PARSE_FAILURE',
      'RENDER_FAILURE',
      'OCR_ENGINE_FAILURE',
      'MODEL_LOAD_FAILURE',
      'CANCELLED',
      'INTERNAL_ERROR'
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
    pageNo: z.number().int().min(1).optional()
  })
])

export type ProcessDocumentRequest = z.infer<typeof processDocumentRequestSchema>
export type CancelJobRequest = z.infer<typeof cancelJobRequestSchema>
export type WorkerRequest = z.infer<typeof workerRequestSchema>
export type WorkerEvent = z.infer<typeof workerEventSchema>
export type WorkerTerminalEvent = Extract<WorkerEvent, { type: 'completed' | 'cancelled' | 'error' }>

export function parseWorkerEvent(value: unknown): WorkerEvent {
  return workerEventSchema.parse(value)
}
