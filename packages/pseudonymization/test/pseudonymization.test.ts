import { describe, expect, it } from 'vitest'
import { formatPseudonym, pseudonymizeText } from '../src/index'

describe('pseudonymization', () => {
  it('replaces exact mention ranges with aliases and stable public tokens', () => {
    expect(
      pseudonymizeText('Synthetic Name signed with Synthetic Name.', [
        { startOffset: 0, endOffset: 14, alias: 'Plaintiff A', publicToken: '@P-8K3F7A' },
        { startOffset: 27, endOffset: 41, alias: 'Plaintiff A', publicToken: '@P-8K3F7A' }
      ])
    ).toBe('Plaintiff A〔@P-8K3F7A〕 signed with Plaintiff A〔@P-8K3F7A〕.')
  })

  it.each([
    { startOffset: Number.NaN, endOffset: 4 },
    { startOffset: 0.5, endOffset: 4 },
    { startOffset: 0, endOffset: Number.POSITIVE_INFINITY }
  ])('rejects non-integer or non-finite offsets: %o', (replacement) => {
    expect(() =>
      pseudonymizeText('SECRET text', [
        { ...replacement, alias: 'Plaintiff A', publicToken: '@P-8K3F7A' }
      ])
    ).toThrow('replacement offsets are outside the source text')
  })

  it('rejects tokens and aliases that would create an ambiguous envelope', () => {
    expect(() => formatPseudonym('Plaintiff A', 'not-a-token')).toThrow('public token has an invalid format')
    expect(() => formatPseudonym('Plaintiff〔A〕', '@P-8K3F7A')).toThrow(
      'alias contains reserved pseudonym delimiters'
    )
  })
})
