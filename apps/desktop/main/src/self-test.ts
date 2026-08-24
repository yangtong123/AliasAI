import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeRuntime, type AliasAiRuntime, type AppLike } from './runtime'
import type { SafeStorage } from './keys'

/** The app surface the packaged self-test drives; Electron's app satisfies it. */
export interface SelfTestApp extends AppLike {
  setPath(name: 'userData', path: string): void
}

export interface SelfTestResult {
  readonly stages: readonly string[]
  readonly sanitizedSample: string
}

/**
 * Builds the same single-page synthetic PDF as the application e2e test
 * (packages/application/test/review-flow.e2e.test.ts): one checksum-valid ID
 * number and one synthetic email in the text layer.
 */
export function syntheticPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\)').replaceAll('(', '\\(')
  const content = `BT /F1 10 Tf 18 84 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${value}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  output += offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(output, 'ascii')
}

function assert(condition: boolean, stage: string, detail: string): void {
  if (!condition) throw new Error(`self-test failed at ${stage}: ${detail}`)
}

/**
 * End-to-end acceptance run against the real wiring — including the bundled
 * Python worker in a packaged install — using a throwaway userData directory:
 * Matter -> import -> parse -> detect -> resolve -> review -> sanitization ->
 * Mock AI -> rehydration. Runs through the same initializeRuntime the GUI
 * uses, so it verifies exactly what a tester's install would execute.
 */
export async function runSelfTest(app: SelfTestApp, safeStorage: SafeStorage): Promise<SelfTestResult> {
  const stages: string[] = []
  const userData = await mkdtemp(join(tmpdir(), 'aliasai-self-test-'))
  app.setPath('userData', userData)
  let runtime: AliasAiRuntime | undefined
  try {
    const stage = (name: string): void => {
      stages.push(name)
      console.log(`self-test: ${name}`)
    }

    runtime = await initializeRuntime(app, safeStorage)
    stage('runtime-initialized')

    const matter = runtime.services.matters.create('AliasAI Self-Test Matter')
    const sourcePath = join(userData, 'synthetic.pdf')
    await writeFile(sourcePath, syntheticPdf('Holder 110101199003077774 synthetic@example.test.'))
    const imported = await runtime.services.importDocs.importFromPath(matter.id, sourcePath)
    stage('matter-and-import')

    await runtime.services.processing.process(imported.id)
    stage('parsed')

    await runtime.services.detection.detect(imported.id)
    stage('detected')

    await runtime.services.resolution.resolve(imported.id)
    const resolved = runtime.services.reviewQuery.getDocumentReview(imported.id)
    assert(resolved.document.parseStatus === 'READY', 'resolve', 'document did not reach READY')
    assert(resolved.counts.unresolved === 2, 'resolve', 'expected both identifier mentions unresolved')
    stage('resolved')

    const mentions = resolved.blocks[0]!.mentions
    const idMention = mentions.find((mention) => mention.type === 'ID_CARD')
    const emailMention = mentions.find((mention) => mention.type === 'EMAIL')
    assert(idMention !== undefined && emailMention !== undefined, 'review', 'expected ID_CARD and EMAIL mentions')
    const created = runtime.services.reviewOperations.createEntityAndAssign(idMention!.mentionId, {
      primaryAlias: 'Holder One',
      entityType: 'PERSON'
    })
    runtime.services.reviewOperations.assignToEntity(emailMention!.mentionId, created.entity.id)
    const reviewed = runtime.services.reviewQuery.getDocumentReview(imported.id)
    assert(reviewed.counts.resolved === 2 && reviewed.counts.unresolved === 0, 'review', 'mentions not fully resolved')
    stage('reviewed')

    const generated = await runtime.services.preview.generatePreview(imported.id)
    if (generated.status !== 'AVAILABLE') {
      throw new Error('self-test failed at sanitization: sanitized preview is not AVAILABLE')
    }
    const sanitized = generated.blocks[0]!.text
    assert(!sanitized.includes('110101199003077774'), 'sanitization', 'protected ID value leaked into sanitized text')
    assert(!sanitized.includes('synthetic@example.test'), 'sanitization', 'protected email leaked into sanitized text')
    assert((sanitized.match(/〔@[IET]-[A-Z0-9]+〕/g) ?? []).length === 2, 'sanitization', 'expected two pseudonym tokens')
    stage('sanitized')

    const ai = await runtime.services.ai.execute(generated.sanitizedDocumentId, true)
    assert(ai.sanitizedResponse === `Mock analysis:\n${sanitized}`, 'ai', 'provider response mismatch')
    assert(!ai.sanitizedResponse.includes('110101199003077774'), 'ai', 'provider response leaked a protected value')
    assert(ai.rehydratedResponse.includes('110101199003077774'), 'rehydration', 'ID value was not restored locally')
    assert(ai.rehydratedResponse.includes('synthetic@example.test'), 'rehydration', 'email was not restored locally')
    assert(ai.unresolvedTokens.length === 0, 'rehydration', 'unexpected unresolved tokens')
    stage('ai-and-rehydration')

    return { stages, sanitizedSample: sanitized }
  } finally {
    runtime?.close()
    await rm(userData, { recursive: true, force: true })
  }
}
