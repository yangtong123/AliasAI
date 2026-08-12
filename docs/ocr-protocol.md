# AliasAI OCR Protocol v1

## Purpose

Defines the stable contract between the TypeScript application core and the local Python document/OCR worker.

The Python worker is replaceable infrastructure. TypeScript application/domain code must depend on this protocol, not on PaddleOCR-specific response shapes.

## Transport

V1 transport: JSON Lines over stdin/stdout.

Each line is one complete JSON message.

Reasons:

- easy local debugging
- simple child-process lifecycle
- streaming progress support
- no localhost server required
- easy to replace later with named pipe/socket without changing message semantics

Do not write diagnostic text to stdout. stdout is protocol-only. Python logs go to stderr.

## Common Envelope

Every message contains:

```json
{
  "protocolVersion": 1,
  "type": "...",
  "jobId": "..."
}
```

Unknown protocol versions must fail explicitly rather than being silently accepted.

## Request: process_document

TypeScript -> Python:

```json
{
  "protocolVersion": 1,
  "type": "process_document",
  "jobId": "019c...",
  "documentId": "019c...",
  "filePath": "/local/path/file.pdf",
  "options": {
    "preferNativeText": true,
    "enableOcr": true,
    "enableLayoutAnalysis": false,
    "pageStart": 1,
    "pageEnd": null
  }
}
```

`filePath` is local-only process input. It must never be returned in normal protocol result payloads.

## Request: cancel_job

```json
{
  "protocolVersion": 1,
  "type": "cancel_job",
  "jobId": "019c..."
}
```

Cancellation is cooperative. The worker should stop at a safe page/block boundary and emit a final cancelled event.

## Event: started

```json
{
  "protocolVersion": 1,
  "type": "started",
  "jobId": "019c...",
  "documentId": "019c..."
}
```

## Event: progress

```json
{
  "protocolVersion": 1,
  "type": "progress",
  "jobId": "019c...",
  "documentId": "019c...",
  "stage": "OCR",
  "completed": 5,
  "total": 100,
  "pageNo": 5
}
```

Suggested stage values:

- `INSPECT`
- `NATIVE_PARSE`
- `RENDER`
- `PREPROCESS`
- `OCR`
- `LAYOUT`
- `FINALIZE`

## Event: page_result

Prefer streaming/persisting page results rather than returning a huge document only at the end.

```json
{
  "protocolVersion": 1,
  "type": "page_result",
  "jobId": "019c...",
  "documentId": "019c...",
  "page": {
    "pageNo": 1,
    "originalWidth": 2480,
    "originalHeight": 3508,
    "rotation": 0,
    "sourceType": "RASTER",
    "blocks": [
      {
        "localId": "b1",
        "blockType": "TEXT",
        "text": "原告张伟",
        "bbox": {
          "x": 0.218,
          "y": 0.328,
          "width": 0.091,
          "height": 0.019
        },
        "confidence": 0.984,
        "source": "OCR",
        "readingOrder": 1
      }
    ]
  }
}
```

The TypeScript side owns application IDs/persistence. `localId` is only for relationships inside the worker result if needed.

## Bounding Box

Protocol bbox is always page-relative normalized coordinates. Every component
is in `[0, 1]`, and `x + width <= 1` and `y + height <= 1` keep the full
rectangle on-page:

```text
x, y, width, height in [0,1]
```

The Python adapter converts OCR raster coordinates before emitting messages.

Do not expose PaddleOCR polygon/pixel coordinate conventions as the application contract.

If polygon precision is later required, introduce it through a backward-compatible protocol revision or optional field while retaining normalized coordinates.

## Page Source Type

Allowed V1 values:

- `NATIVE`
- `RASTER`
- `MIXED`

## Block Type

Allowed V1 values:

- `TEXT`
- `TABLE`
- `IMAGE`

V1 may initially emit only TEXT blocks while keeping the enum stable.

## Block Source

Allowed V1 values:

- `NATIVE`
- `OCR`

## Event: completed

```json
{
  "protocolVersion": 1,
  "type": "completed",
  "jobId": "019c...",
  "documentId": "019c...",
  "pageCount": 100,
  "processedPages": 100
}
```

## Event: cancelled

```json
{
  "protocolVersion": 1,
  "type": "cancelled",
  "jobId": "019c...",
  "documentId": "019c...",
  "lastCompletedPage": 37
}
```

## Event: error

```json
{
  "protocolVersion": 1,
  "type": "error",
  "jobId": "019c...",
  "documentId": "019c...",
  "code": "OCR_ENGINE_FAILURE",
  "message": "OCR processing failed",
  "retryable": true,
  "pageNo": 17
}
```

Error messages must not include full document text or sensitive source values.

Suggested V1 error codes:

- `UNSUPPORTED_DOCUMENT`
- `INVALID_REQUEST`
- `FILE_NOT_FOUND`
- `PDF_PARSE_FAILURE`
- `RENDER_FAILURE`
- `OCR_ENGINE_FAILURE`
- `MODEL_LOAD_FAILURE`
- `CANCELLED`
- `INTERNAL_ERROR`

## Native Text Priority

When `preferNativeText=true`:

1. inspect whether a page has a reliable native text layer,
2. use native text extraction when suitable,
3. use OCR for raster-only content,
4. support mixed pages when practical.

Do not OCR reliable native PDF text merely because OCR is available.

## Privacy Boundary

Python worker responsibilities:

- inspect document
- render page if needed
- preprocess image
- native text extraction
- OCR
- optional layout/NER adapters when explicitly invoked by later protocols
- emit normalized Document Model data

Python worker must not:

- access SQLite application tables directly
- create Entities
- assign Mentions to Entities
- generate aliases/Public Tokens
- call external AI APIs
- persist real identity mappings

## Logging

stdout: protocol only.

stderr: operational logging only.

Never log full extracted text by default. Logs may contain:

- job ID
- document ID
- page number
- stage
- model name/version
- elapsed timing
- structured error code

## Schema Validation

Both sides validate messages:

- TypeScript: runtime schema validation (for example Zod)
- Python: typed/schema validation (for example Pydantic or equivalent)

A message that fails schema validation terminates/fails the affected job explicitly.

## Mock-first Development

Implement Protocol v1 with a mock Python worker before integrating PaddleOCR.

Contract test flow:

```text
Node
-> process_document
-> Python mock
-> started
-> progress
-> page_result
-> completed
-> Node schema validation
```

Then replace the mock OCR adapter with PaddleOCR while preserving Protocol v1.

## OCR Evaluation Principle

AliasAI is not optimizing only for OCR character error rate.

Primary downstream concern is sensitive-region detection recall. A slightly incorrect character can still be safely removed if the region is found; a fully missed sensitive region is a privacy failure.

Therefore benchmark OCR together with downstream sensitive-region recall.
