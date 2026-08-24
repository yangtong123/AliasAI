import { describe, expect, it } from 'vitest'
import {
  foldDecimalDigits,
  isValidNormalizedValue,
  mentionTypeToProtectedValueType,
  normalizeMentionValue
} from '../src/normalization'
import type { MentionType, ProtectedValueType } from '@aliasai/domain'

describe('mentionTypeToProtectedValueType', () => {
  it('maps every MentionType to its ProtectedValueType or undefined', () => {
    const expected: Record<MentionType, ProtectedValueType | undefined> = {
      PERSON: 'PERSON_NAME',
      ORGANIZATION: 'ORG_NAME',
      PHONE: 'PHONE',
      EMAIL: 'EMAIL',
      ID_CARD: 'ID_CARD',
      BANK_ACCOUNT: 'BANK_ACCOUNT',
      ADDRESS: 'ADDRESS',
      CASE_NUMBER: undefined,
      CONTRACT_NUMBER: undefined,
      COURT: undefined,
      LAWYER: undefined,
      JUDGE: undefined
    }
    for (const [type, protectedValueType] of Object.entries(expected)) {
      expect(mentionTypeToProtectedValueType(type as MentionType)).toBe(protectedValueType)
    }
  })
})

describe('normalizeMentionValue', () => {
  it('trims, collapses whitespace, and applies NFKC for name-like types', () => {
    expect(normalizeMentionValue('PERSON', '  张   伟  ')).toBe('张 伟')
    expect(normalizeMentionValue('ORGANIZATION', 'ＡＢＣ　科技  有限公司')).toBe('ABC 科技 有限公司')
    expect(normalizeMentionValue('ADDRESS', '  北京市   海淀区 ')).toBe('北京市 海淀区')
  })

  it('lowercases emails after generic normalization', () => {
    expect(normalizeMentionValue('EMAIL', '  Alice.Smith＠Example.COM ')).toBe('alice.smith@example.com')
  })

  it('strips phone punctuation and drops a redundant +86 prefix for mainland mobiles', () => {
    expect(normalizeMentionValue('PHONE', '+86 138-0013-8000')).toBe('13800138000')
    expect(normalizeMentionValue('PHONE', '86 138 0013 8000')).toBe('13800138000')
    expect(normalizeMentionValue('PHONE', '138-0013-8000')).toBe('13800138000')
  })

  it('keeps a non-mobile 86-prefixed phone number intact', () => {
    expect(normalizeMentionValue('PHONE', '+86 10 8888 6666')).toBe('861088886666')
  })

  it('removes whitespace and uppercases ID cards, including a trailing x', () => {
    expect(normalizeMentionValue('ID_CARD', ' 110101 19900307 123x ')).toBe('11010119900307123X')
    expect(normalizeMentionValue('ID_CARD', 'ｘ１２３')).toBe('X123')
  })

  it('keeps only digits for bank accounts', () => {
    expect(normalizeMentionValue('BANK_ACCOUNT', '6222 0212 3456 7890')).toBe('6222021234567890')
  })

  it('treats comma, colon, and semicolon group separators as part of one rendered number', () => {
    expect(normalizeMentionValue('PHONE', '138:0013:8000')).toBe('13800138000')
    expect(normalizeMentionValue('PHONE', '138；0013；8000')).toBe('13800138000')
    expect(normalizeMentionValue('BANK_ACCOUNT', '6222,0210,0110,1234')).toBe('6222021001101234')
    expect(normalizeMentionValue('BANK_ACCOUNT', '6222、0210、0110、1234')).toBe('6222021001101234')
  })

  it('keeps tab and newline boundaries inside digit values so validation rejects them', () => {
    // Tabs and newlines are hard candidate boundaries for the outbound
    // scanner; normalization must not collapse them into joinable spaces.
    const tabSeparated = normalizeMentionValue('PHONE', '1380\t013\t8000')
    expect(tabSeparated).toBe('1380\t013\t8000')
    expect(isValidNormalizedValue('PHONE', tabSeparated)).toBe(false)
    const lineBroken = normalizeMentionValue('PHONE', '1380\n013\t8000')
    expect(lineBroken).toBe('1380\n013\t8000')
    expect(isValidNormalizedValue('PHONE', lineBroken)).toBe(false)
    // Leading and trailing whitespace still trims, and multi-space inside a
    // number stays joinable: both spaces are shared separators.
    expect(normalizeMentionValue('PHONE', '  138  0013 8000 ')).toBe('13800138000')
  })

  it('folds non-ASCII decimal digits to ASCII on the digit types', () => {
    expect(normalizeMentionValue('PHONE', '١٣٨٠٠١٣٨٠٠٠')).toBe('13800138000')
    expect(normalizeMentionValue('PHONE', '۱۳۸۰۰۱۳۸۰۰۰')).toBe('13800138000')
    expect(normalizeMentionValue('BANK_ACCOUNT', '۶۲۲۲۰۲۱۰۰۱۱۰۱۲۳۴')).toBe('6222021001101234')
    // Osmanya digits are astral-plane; the fold must cover every Nd block,
    // not only the common BMP scripts.
    expect(normalizeMentionValue('PHONE', '𐒡𐒣𐒨𐒠𐒠𐒡𐒣𐒨𐒠𐒠𐒠')).toBe('13800138000')
  })

  it('folds every Unicode Nd digit deterministically (exhaustive contract)', () => {
    const decimal = /^\p{Nd}$/u
    const anchors = new Map([
      ['5', '5'],
      ['٨', '8'], // Arabic-Indic
      ['۵', '5'], // Extended Arabic-Indic
      ['𝟘', '0'], // Mathematical double-struck (adjacent chained decade)
      ['𐒠', '0'], // Osmanya (astral)
      ['９', '9'] // Fullwidth
    ])
    let previous = -2
    let runStart = -1
    let runLength = 0
    let blockCount = 0
    // Independent derivation: every Nd block is a ten-code-point 0–9 decade;
    // adjacent decades (for example the chained Mathematical digit styles)
    // form longer consecutive runs, so the offset inside the run taken modulo
    // ten is the digit value.
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const char = String.fromCodePoint(codePoint)
      if (!decimal.test(char)) continue
      if (codePoint !== previous + 1) {
        if (blockCount > 0) expect(runLength % 10).toBe(0)
        runStart = codePoint
        runLength = 0
        blockCount += 1
      }
      runLength += 1
      const expected = String.fromCharCode(0x30 + ((codePoint - runStart) % 10))
      expect(foldDecimalDigits(char)).toBe(expected)
      const anchor = anchors.get(char)
      if (anchor !== undefined) expect(foldDecimalDigits(char)).toBe(anchor)
      previous = codePoint
    }
    expect(runLength % 10).toBe(0)
    // Current engines ship 70+ Nd blocks; a collapse to the ASCII-only block
    // would mean the derived fold silently stopped covering non-ASCII digits.
    expect(blockCount).toBeGreaterThan(60)
  })

  it('preserves prose glued into a rendered number so validation rejects it', () => {
    const normalized = normalizeMentionValue('PHONE', '电话:13800138000')
    expect(normalized).toBe('电话13800138000')
    expect(isValidNormalizedValue('PHONE', normalized)).toBe(false)
  })

  it('applies only the generic rule to metadata types', () => {
    expect(normalizeMentionValue('CASE_NUMBER', ' （2024） 京01民初  123号 ')).toBe('(2024) 京01民初 123号')
    expect(normalizeMentionValue('COURT', '  北京市  海淀区人民法院 ')).toBe('北京市 海淀区人民法院')
  })

  it('never mutates the source text', () => {
    const source = '  张   伟  '
    normalizeMentionValue('PERSON', source)
    expect(source).toBe('  张   伟  ')
  })
})

describe('isValidNormalizedValue', () => {
  it('rejects empty values for every type', () => {
    const types: readonly MentionType[] = [
      'PERSON',
      'ORGANIZATION',
      'PHONE',
      'EMAIL',
      'ID_CARD',
      'BANK_ACCOUNT',
      'ADDRESS',
      'CASE_NUMBER',
      'CONTRACT_NUMBER',
      'COURT',
      'LAWYER',
      'JUDGE'
    ]
    for (const type of types) expect(isValidNormalizedValue(type, '')).toBe(false)
  })

  it('validates ID card shape, birth date, and check digit (GB 11643-1999)', () => {
    // Checksum-valid synthetics, computed with the ISO 7064 MOD 11-2 weights.
    expect(isValidNormalizedValue('ID_CARD', '110101199003077774')).toBe(true)
    expect(isValidNormalizedValue('ID_CARD', '22020219850506321X')).toBe(true)
    expect(isValidNormalizedValue('ID_CARD', '123')).toBe(false)
    expect(isValidNormalizedValue('ID_CARD', '1101011990030777X')).toBe(false)
    expect(isValidNormalizedValue('ID_CARD', '11010119900307777x')).toBe(false)
    expect(isValidNormalizedValue('ID_CARD', '11010119900307777A')).toBe(false)
    // Right shape but a wrong check digit or an impossible birth date.
    expect(isValidNormalizedValue('ID_CARD', '11010119900307777X')).toBe(false)
    expect(isValidNormalizedValue('ID_CARD', '110101199003077773')).toBe(false)
    expect(isValidNormalizedValue('ID_CARD', '110101199013077770')).toBe(false)
    expect(isValidNormalizedValue('ID_CARD', '110101199002307771')).toBe(false)
    // A checksum-valid number whose birth date lies in the future.
    const nextYear = new Date().getFullYear() + 1
    const futureBase = `110101${nextYear}0101001`
    let sum = 0
    for (const [index, weight] of [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2].entries()) {
      sum += Number(futureBase[index]) * weight
    }
    expect(isValidNormalizedValue('ID_CARD', `${futureBase}${'10X98765432'[sum % 11]}`)).toBe(false)
  })

  it('accepts mainland mobiles and digit lines of 5 to 20 digits', () => {
    expect(isValidNormalizedValue('PHONE', '13800138000')).toBe(true)
    expect(isValidNormalizedValue('PHONE', '861088886666')).toBe(true)
    expect(isValidNormalizedValue('PHONE', '12345')).toBe(true)
    expect(isValidNormalizedValue('PHONE', '23800138000')).toBe(true)
    expect(isValidNormalizedValue('PHONE', '1234')).toBe(false)
    expect(isValidNormalizedValue('PHONE', '1'.repeat(20))).toBe(true)
    expect(isValidNormalizedValue('PHONE', '1'.repeat(21))).toBe(false)
    expect(isValidNormalizedValue('PHONE', '1380013800a')).toBe(false)
  })

  it('requires exactly one @ with non-empty local and domain parts for emails', () => {
    expect(isValidNormalizedValue('EMAIL', 'synthetic@example.test')).toBe(true)
    expect(isValidNormalizedValue('EMAIL', 'synthetic.example.test')).toBe(false)
    expect(isValidNormalizedValue('EMAIL', '@example.test')).toBe(false)
    expect(isValidNormalizedValue('EMAIL', 'synthetic@')).toBe(false)
    expect(isValidNormalizedValue('EMAIL', 'a@b@c.test')).toBe(false)
  })

  it('requires 8 to 30 digits for bank accounts', () => {
    expect(isValidNormalizedValue('BANK_ACCOUNT', '6222021234567890')).toBe(true)
    expect(isValidNormalizedValue('BANK_ACCOUNT', '12345678')).toBe(true)
    expect(isValidNormalizedValue('BANK_ACCOUNT', '1234567')).toBe(false)
    expect(isValidNormalizedValue('BANK_ACCOUNT', '1'.repeat(31))).toBe(false)
    expect(isValidNormalizedValue('BANK_ACCOUNT', '6222 0212')).toBe(false)
  })

  it('accepts any non-empty name or address and rejects metadata types', () => {
    expect(isValidNormalizedValue('PERSON', '张三')).toBe(true)
    expect(isValidNormalizedValue('ORGANIZATION', 'Synthetic Ltd.')).toBe(true)
    expect(isValidNormalizedValue('ADDRESS', '北京市 海淀区')).toBe(true)
    expect(isValidNormalizedValue('CASE_NUMBER', '(2024) 京01民初 123号')).toBe(false)
    expect(isValidNormalizedValue('COURT', '北京市 海淀区人民法院')).toBe(false)
    expect(isValidNormalizedValue('LAWYER', 'Synthetic Lawyer')).toBe(false)
  })
})
