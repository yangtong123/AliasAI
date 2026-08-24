import { describe, expect, it, vi } from 'vitest'
import { isValidNormalizedValue, normalizeProtectedValue } from '@aliasai/entity-resolution'
import {
  AiLeakDetectedError,
  MAX_OUTBOUND_PAYLOAD_BYTES,
  assertSafeOutboundPayload,
  isDeniedValueIndexable,
  MockAiProvider,
  scanOutboundPayload,
  type OutboundLeakScanInput
} from '../src'

const token = '@N-ABC123'

function scan(overrides: Partial<OutboundLeakScanInput> & { content: string }) {
  return scanOutboundPayload({
    allowedTokens: new Set([token]),
    deniedValues: [],
    forbiddenIdentifiers: [],
    ...overrides
  })
}

describe('AI provider boundary', () => {
  it('passes only sanitized content to a provider', async () => {
    const responder = vi.fn((content: string) => `分析：${content}`)
    const provider = new MockAiProvider(responder)

    await expect(provider.execute({ content: `原告甲〔${token}〕` })).resolves.toEqual({
      content: `分析：原告甲〔${token}〕`
    })
    expect(responder).toHaveBeenCalledWith(`原告甲〔${token}〕`)
  })

  it('accepts a complete payload containing only known restoration tokens', () => {
    expect(
      scanOutboundPayload({
        content: `原告甲〔${token}〕提交证据。`,
        allowedTokens: new Set([token]),
        deniedValues: [{ type: 'PERSON_NAME', value: '张伟' }],
        forbiddenIdentifiers: ['019c0000-0000-7000-8000-000000000001']
      })
    ).toEqual([])
  })

  it.each([
    ['protected plaintext', `张伟与原告甲〔${token}〕`, 'PROTECTED_VALUE_LEAK'],
    ['internal identifier', `019c0000-0000-7000-8000-000000000001 原告甲〔${token}〕`, 'INTERNAL_IDENTIFIER_LEAK'],
    ['unknown token', `原告甲〔@N-UNKNOWN〕`, 'UNKNOWN_TOKEN'],
    ['lowercase token', '原告甲〔@N-lower〕', 'MALFORMED_TOKEN'],
    ['embedded delimiter', '原告甲〔@N-A-B〕', 'MALFORMED_TOKEN']
  ])('rejects %s before provider dispatch', (_name, content, code) => {
    const input = {
      content,
      allowedTokens: new Set([token]),
      deniedValues: [{ type: 'PERSON_NAME' as const, value: '张伟' }],
      forbiddenIdentifiers: ['019c0000-0000-7000-8000-000000000001']
    }
    expect(() => assertSafeOutboundPayload(input)).toThrow(AiLeakDetectedError)
    expect(scanOutboundPayload(input).map((finding) => finding.code)).toContain(code)
  })

  it('rejects a truncated artifact that omits a mapped token', () => {
    expect(
      scanOutboundPayload({
        content: '没有任何映射锚点',
        allowedTokens: new Set([token]),
        deniedValues: [],
        forbiddenIdentifiers: []
      })
    ).toEqual([{ code: 'MISSING_TOKEN', index: 0 }])
  })

  it('rejects a UUID-shaped identifier even when it is absent from the explicit denylist', () => {
    expect(
      scan({ content: `019d1234-5678-7abc-8def-0123456789ab 原告甲〔${token}〕` }).map((f) => f.code)
    ).toContain('INTERNAL_IDENTIFIER_LEAK')
  })

  it.each([
    // Vault value first, leaked content variant second.
    ['phone with separators', 'PHONE', '138 0013 8000', '联系电话：138-0013-8000。'],
    ['phone with +86 prefix', 'PHONE', '13800138000', '联系电话：+86 138 0013 8000。'],
    ['phone in full-width digits', 'PHONE', '13800138000', '联系电话：１３８００１３８０００。'],
    ['phone with parentheses', 'PHONE', '13800138000', '联系电话：(138) 0013-8000。'],
    ['phone with extension suffix', 'PHONE', '13800138000', '联系电话：138-0013-8000/123。'],
    ['phone with unicode dashes', 'PHONE', '13800138000', '联系电话：138–0013–8000。'],
    ['phone with zero-width separators', 'PHONE', '13800138000', '联系电话：138\u200B0013\u200B8000。'],
    ['phone followed by a year in the same run', 'PHONE', '13800138000', '电话 138-0013-8000 2026年立案。'],
    ['phone with colon separators', 'PHONE', '13800138000', '联系电话：138:0013:8000。'],
    ['phone with comma separators', 'PHONE', '13800138000', '联系电话 138,0013,8000。'],
    ['phone in Arabic-Indic digits', 'PHONE', '13800138000', '联系电话 ١٣٨٠٠١٣٨٠٠٠。'],
    ['email in different case', 'EMAIL', 'Synthetic@Example.Test', '邮箱 SYNTHETIC@example.test 已登记。'],
    ['email with spaces', 'EMAIL', 'synthetic@example.test', '邮箱 synthetic @ example.test 已登记。'],
    ['spaced vault email against spaced uppercase content', 'EMAIL', 'Synthetic @ Example.Test', '邮箱 SYNTHETIC @ EXAMPLE.TEST 已登记。'],
    ['id card with spaces and lowercase x', 'ID_CARD', '11010119900307777X', '证号 110101 19900307 777x。'],
    ['id card with dashes and trailing X', 'ID_CARD', '11010119900307777X', '证号 110101-19900307-777X。'],
    ['id card with check char glued to CJK prose', 'ID_CARD', '11010119900307777X', '证号110101-19900307-777X已登记。原告甲〔@N-ABC123〕'],
    ['id card with lowercase check char glued to CJK prose', 'ID_CARD', '11010119900307777X', '证号 110101 19900307 777x身份证。'],
    ['bank account with separators', 'BANK_ACCOUNT', '6222 0210 0110 1234', '卡号6222-0210-0110-1234。'],
    ['bank account with comma separators', 'BANK_ACCOUNT', '6222021001101234', '卡号6222,0210,0110,1234。'],
    ['bank account with ideographic commas', 'BANK_ACCOUNT', '6222021001101234', '卡号6222、0210、0110、1234。'],
    ['bank account in Extended Arabic-Indic digits', 'BANK_ACCOUNT', '6222021001101234', '卡号۶۲۲۲۰۲۱۰۰۱۱۰۱۲۳۴。'],
    ['name with collapsed whitespace', 'PERSON_NAME', '张  三', '当事人张  三 到庭。']
  ])('detects the %s variant of a denied value', (_name, type, denied, content) => {
    const findings = scan({ content, deniedValues: [{ type: type as never, value: denied }] })
    expect(findings).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
    expect(findings.filter((finding) => finding.code === 'PROTECTED_VALUE_LEAK')).toHaveLength(1)
  })

  it('does not concatenate unrelated digit runs into a denied value', () => {
    // The phone never appears as one bounded span; prose separates the runs.
    expect(
      scan({
        content: '编号 1380，日期 013，页码 8000。原告甲〔@N-ABC123〕',
        deniedValues: [{ type: 'PHONE', value: '13800138000' }]
      })
    ).toEqual([])
    expect(
      scan({
        content: 'phone=13800, route=138, id=0000 end〔@N-ABC123〕',
        deniedValues: [{ type: 'PHONE', value: '13800138000' }]
      })
    ).toEqual([])
  })

  it('treats line breaks and tabs as hard candidate boundaries', () => {
    // Blocks are joined with \n\n; page footers must not combine with the next
    // page's numbers, and tab-separated columns stay separate.
    expect(
      scan({
        content: '编号 1380\n013    8000\n\n原告甲〔@N-ABC123〕',
        deniedValues: [{ type: 'PHONE', value: '13800138000' }]
      })
    ).toEqual([])
    expect(
      scan({
        content: '1380\t013\t8000 原告甲〔@N-ABC123〕',
        deniedValues: [{ type: 'PHONE', value: '13800138000' }]
      })
    ).toEqual([])
  })

  it('does not flag unrelated digit runs', () => {
    expect(
      scan({
        content: `订单号 20260820 与原告甲〔${token}〕无关`,
        deniedValues: [{ type: 'PHONE', value: '13800138000' }]
      })
    ).toEqual([])
  })

  it('fails closed for below-threshold digit denylist values', () => {
    // No valid PHONE or ID_CARD this short can enter the Vault, so a
    // below-floor denylist row is corrupt or legacy data: matching it as a
    // standalone number would flag unrelated digit runs everywhere, so the
    // entry is flagged instead and the execution fails closed.
    expect(
      scan({ content: `电话12-34 原告甲〔${token}〕`, deniedValues: [{ type: 'PHONE', value: '1234' }] })
    ).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
    expect(
      scan({ content: `证号1234 原告甲〔${token}〕`, deniedValues: [{ type: 'ID_CARD', value: '1234' }] })
    ).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
  })

  it('flags a value known from anywhere in the Matter, not only mapped mentions', () => {
    // The phone is not mapped in this artifact but is a known Matter value.
    const findings = scan({
      content: `备用号码 13800138000 与原告甲〔${token}〕。`,
      deniedValues: [
        { type: 'PERSON_NAME', value: '张伟' },
        { type: 'PHONE', value: '13800138000' }
      ]
    })
    expect(findings).toEqual([{ code: 'PROTECTED_VALUE_LEAK', index: 1 }])
  })

  it('covers the full PHONE contract range, including out-of-contract legacy values', () => {
    // 20 digits: the longest value the domain admits to the Vault.
    expect(
      scan({ content: `line ${'1'.repeat(20)} ${token}`, deniedValues: [{ type: 'PHONE', value: '1'.repeat(20) }] })
    ).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
    // 21 digits: no longer admissible, but a legacy Vault value must still be caught.
    expect(
      scan({ content: `line ${'1'.repeat(21)} ${token}`, deniedValues: [{ type: 'PHONE', value: '1'.repeat(21) }] })
    ).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
  })

  it('fails closed for denied digit values no bounded window can verify', () => {
    // Longer than any legal (or windowed) number: absence cannot be proven by
    // equality, so the entry is flagged instead of silently bypassing the scan.
    expect(
      scan({ content: `clean content ${token}`, deniedValues: [{ type: 'PHONE', value: '1'.repeat(64) }] })
    ).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
  })

  it('fails closed for denylist values the digit grammar cannot represent', () => {
    // A legacy row normalized under the old whitespace-collapsing rules: the
    // streaming matcher can never equality-match it against a pure-digit
    // window, so it is flagged instead of silently matching nothing.
    expect(isDeniedValueIndexable('PHONE', '1380\n013\t8000')).toBe(false)
    expect(isDeniedValueIndexable('PHONE', '13800138000')).toBe(true)
    expect(isDeniedValueIndexable('PHONE', '电话13800138000')).toBe(false)
    expect(isDeniedValueIndexable('PHONE', '1234')).toBe(false)
    expect(isDeniedValueIndexable('ID_CARD', '1234')).toBe(false)
    expect(isDeniedValueIndexable('ID_CARD', '11010119900307777X')).toBe(true)
    expect(isDeniedValueIndexable('PERSON_NAME', '张伟')).toBe(true)
    expect(
      scan({
        content: `备用号码 138-0013-8000。原告甲〔${token}〕`,
        deniedValues: [{ type: 'PHONE', value: '1380\n013\t8000' }]
      })
    ).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
  })

  it('rejects an oversized payload outright instead of scanning it', () => {
    const oversized = `原告甲〔${token}〕${'x'.repeat(MAX_OUTBOUND_PAYLOAD_BYTES)}`
    expect(
      scan({ content: oversized, deniedValues: [{ type: 'PERSON_NAME', value: '张伟' }] }).map(
        (finding) => finding.code
      )
    ).toEqual(['PAYLOAD_TOO_LARGE'])
  })

  it('stays bounded on digit-dense adversarial content', () => {
    // 100k single-digit groups in one run: the streaming matcher keeps only a
    // bounded suffix of the run (never the whole-document groups), so neither
    // time nor memory scales with content size.
    const content = `${'1 '.repeat(100_000)}${token}`
    expect(scan({ content, deniedValues: [{ type: 'PHONE', value: '13800138000' }] })).toEqual([])
    expect(
      scan({
        content: `${content} 13800138000`,
        deniedValues: [{ type: 'PHONE', value: '13800138000' }]
      })
    ).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
  })

  it.each([
    // Shared boundary-contract vectors: what normalization joins into the
    // denied value (column 2) the scanner must flag (column 3). Tab and
    // newline renderings are outside the contract on BOTH sides — invalid to
    // normalize, never joined by the scanner. The prose-glued rendering is
    // rejected by normalization but still flagged: its digits form a complete
    // run in the content, and the scanner fails closed on the superset.
    ['138-0013-8000', '13800138000', true],
    ['138:0013:8000', '13800138000', true],
    ['138,0013,8000', '13800138000', true],
    ['138–0013–8000', '13800138000', true],
    ['138\u200B0013\u200B8000', '13800138000', true],
    ['(138) 0013-8000', '13800138000', true],
    ['86 138 0013 8000', '13800138000', true],
    ['１３８００１３８０００', '13800138000', true],
    ['١٣٨٠٠١٣٨٠٠٠', '13800138000', true],
    ['𐒡𐒣𐒨𐒠𐒠𐒡𐒣𐒨𐒠𐒠𐒠', '13800138000', true],
    ['1380\t013\t8000', '1380\t013\t8000', false],
    ['1380\n013\t8000', '1380\n013\t8000', false],
    ['电话13800138000', '电话13800138000', true]
  ])('shares the boundary contract with normalization for %s', (rendering, normalized, leaks) => {
    const type = 'PHONE' as const
    expect(normalizeProtectedValue(type, rendering)).toBe(normalized)
    expect(isValidNormalizedValue(type, normalized)).toBe(/^\d{5,20}$/.test(normalized))
    const findings = scan({
      content: `前缀 ${rendering} 后缀〔${token}〕`,
      deniedValues: [{ type, value: '13800138000' }]
    })
    if (leaks) {
      expect(findings).toContainEqual({ code: 'PROTECTED_VALUE_LEAK', index: 0 })
    } else {
      expect(findings.filter((finding) => finding.code === 'PROTECTED_VALUE_LEAK')).toHaveLength(0)
    }
  })
})
