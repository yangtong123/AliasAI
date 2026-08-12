import { describe, expect, it } from 'vitest'
import { rehydrateText } from '../src/index'

describe('rehydration', () => {
  const mappings = new Map([
    ['@P-8K3F7A', { value: 'Synthetic Name', aliases: ['Plaintiff A', '原告甲'] }]
  ])

  it('uses a Public Token without consuming unrelated preceding prose', () => {
    expect(rehydrateText('Before Plaintiff A〔@P-8K3F7A〕 replied.', mappings)).toBe(
      'Before Synthetic Name replied.'
    )
    expect(rehydrateText('法院认为原告甲〔@P-8K3F7A〕应当举证。', mappings)).toBe(
      '法院认为Synthetic Name应当举证。'
    )
  })

  it('restores a bare Public Token without relying on an alias', () => {
    expect(rehydrateText('The subject @P-8K3F7A must respond.', mappings)).toBe(
      'The subject Synthetic Name must respond.'
    )
  })

  it('preserves unknown tokens and unexpectedly edited aliases for review', () => {
    expect(rehydrateText('Unknown〔@O-NONE〕 and Edited Alias〔@P-8K3F7A〕.', mappings)).toBe(
      'Unknown〔@O-NONE〕 and Edited Alias〔@P-8K3F7A〕.'
    )
  })

  it('does not rewrite token-like substrings inside larger identifiers', () => {
    expect(rehydrateText('prefix@P-8K3F7Asuffix', mappings)).toBe('prefix@P-8K3F7Asuffix')
  })

  it('does not treat an ASCII word suffix as the complete alias', () => {
    const shortAlias = new Map([['@P-8K3F7A', { value: 'Synthetic Name', aliases: ['A'] }]])

    expect(rehydrateText('DATA〔@P-8K3F7A〕', shortAlias)).toBe('DATA〔@P-8K3F7A〕')
    expect(rehydrateText('A〔@P-8K3F7A〕', shortAlias)).toBe('Synthetic Name')
  })

  it('uses the longest matching historic alias for the same token', () => {
    const overlappingAliases = new Map([
      ['@P-8K3F7A', { value: 'Synthetic Name', aliases: ['A', 'Plaintiff A'] }]
    ])

    expect(rehydrateText('Plaintiff A〔@P-8K3F7A〕', overlappingAliases)).toBe('Synthetic Name')
  })
})
