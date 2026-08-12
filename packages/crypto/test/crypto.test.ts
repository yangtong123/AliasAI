import { describe, expect, it } from 'vitest'
import {
  constantTimeEqual,
  CryptoInvariantError,
  decrypt,
  encrypt,
  fingerprintNormalizedValue,
  generateKey,
  generatePublicToken,
  generateUuidV7
} from '../src/index'

describe('V1 crypto primitives', () => {
  it('round-trips synthetic bytes through the versioned AES-GCM envelope', () => {
    const key = generateKey()
    const plaintext = Buffer.from('synthetic protected value')
    const aad = Buffer.from('matter-1:PERSON_NAME')
    const envelope = encrypt(plaintext, key, aad)

    expect(envelope).not.toEqual(plaintext)
    expect(decrypt(envelope, key, aad)).toEqual(plaintext)
  })

  it('rejects tampered ciphertext and incorrect authenticated data', () => {
    const key = generateKey()
    const envelope = encrypt(Buffer.from('synthetic'), key, Buffer.from('context-a'))
    const lastByteOffset = envelope.length - 1
    envelope.writeUInt8(envelope.readUInt8(lastByteOffset) ^ 1, lastByteOffset)

    expect(() => decrypt(envelope, key, Buffer.from('context-a'))).toThrow(CryptoInvariantError)
    expect(() =>
      decrypt(encrypt(Buffer.from('synthetic'), key, Buffer.from('context-a')), key, Buffer.from('context-b'))
    ).toThrow(
      CryptoInvariantError
    )
  })

  it('creates a Matter-scoped HMAC fingerprint rather than a plain hash', () => {
    const value = 'normalized synthetic value'
    const matterOne = fingerprintNormalizedValue(Buffer.alloc(32, 1), value)
    const matterTwo = fingerprintNormalizedValue(Buffer.alloc(32, 2), value)

    expect(matterOne).toHaveLength(32)
    expect(constantTimeEqual(matterOne, matterTwo)).toBe(false)
    expect(constantTimeEqual(matterOne, fingerprintNormalizedValue(Buffer.alloc(32, 1), value))).toBe(true)
  })

  it('requires 256-bit keys', () => {
    expect(() => encrypt(Buffer.from('synthetic'), Buffer.alloc(31), Buffer.from('context'))).toThrow(
      'V1 keys must be exactly 32 bytes'
    )
    expect(() => encrypt(Buffer.from('synthetic'), Buffer.alloc(32), Buffer.alloc(0))).toThrow(
      'encrypted fields require a non-empty authenticated context'
    )
  })

  it('generates UUIDv7 identifiers with the documented version and variant bits', () => {
    const identifier = generateUuidV7(1_725_000_000_000)

    expect(identifier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('creates opaque public tokens without real-identity input', () => {
    expect(generatePublicToken('PERSON')).toMatch(/^@P-[0-9A-F]{16}$/)
    expect(generatePublicToken('ORGANIZATION')).toMatch(/^@O-[0-9A-F]{16}$/)
  })
})
