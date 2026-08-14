import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ENVELOPE_VERSION = 1
const AES_256_GCM = 1
const NONCE_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const HEADER_LENGTH = 2 + NONCE_LENGTH
const MIN_KEY_LENGTH = 32

export class CryptoInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoInvariantError'
  }
}

/** Generates a 256-bit key suitable for encryption or Matter-local HMAC search. */
export function generateKey(): Buffer {
  return randomBytes(MIN_KEY_LENGTH)
}

/** Generates a UUIDv7 identifier using a Unix-millisecond timestamp. */
export function generateUuidV7(timestamp = Date.now()): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= 2 ** 48) {
    throw new CryptoInvariantError('UUIDv7 timestamp must fit within 48 bits')
  }

  const bytes = randomBytes(16)
  let remainingTimestamp = BigInt(timestamp)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remainingTimestamp & 0xffn)
    remainingTimestamp >>= 8n
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Generates a Matter-local opaque anchor; it is never derived from identity data. */
export function generatePublicToken(entityType: 'PERSON' | 'ORGANIZATION'): string {
  const prefix = entityType === 'PERSON' ? 'P' : 'O'
  return `@${prefix}-${randomBytes(8).toString('hex').toUpperCase()}`
}

/**
 * Encrypts bytes into the versioned V1 binary envelope:
 * version | algorithm | nonce | ciphertext | authentication tag.
 */
export function encrypt(plaintext: Buffer, key: Buffer, additionalAuthenticatedData: Buffer): Buffer {
  assertKey(key)
  assertContext(additionalAuthenticatedData)
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_LENGTH })
  cipher.setAAD(additionalAuthenticatedData)

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION, AES_256_GCM]), nonce, ciphertext, tag])
}

/** Decrypts a V1 AES-256-GCM envelope, rejecting malformed or unauthenticated bytes. */
export function decrypt(envelope: Buffer, key: Buffer, additionalAuthenticatedData: Buffer): Buffer {
  assertKey(key)
  assertContext(additionalAuthenticatedData)
  if (envelope.length < HEADER_LENGTH + AUTH_TAG_LENGTH) {
    throw new CryptoInvariantError('encrypted envelope is too short')
  }
  if (envelope[0] !== ENVELOPE_VERSION) {
    throw new CryptoInvariantError('unsupported encrypted envelope version')
  }
  if (envelope[1] !== AES_256_GCM) {
    throw new CryptoInvariantError('unsupported encrypted envelope algorithm')
  }

  const nonce = envelope.subarray(2, HEADER_LENGTH)
  const tag = envelope.subarray(envelope.length - AUTH_TAG_LENGTH)
  const ciphertext = envelope.subarray(HEADER_LENGTH, envelope.length - AUTH_TAG_LENGTH)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_LENGTH })
    decipher.setAAD(additionalAuthenticatedData)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new CryptoInvariantError('encrypted envelope authentication failed')
  }
}

/**
 * Derives the exact-match lookup value required by the schema. Callers must
 * normalize before passing input; raw protected values are never persisted.
 */
export function fingerprintNormalizedValue(matterSearchKey: Buffer, normalizedValue: string): Buffer {
  assertKey(matterSearchKey)
  return createHmac('sha256', matterSearchKey).update(normalizedValue, 'utf8').digest()
}

/**
 * Derives the Matter-local HMAC search key from the application search key.
 * The derived key is never persisted and must not be reused as a persistence key.
 */
export function deriveMatterSearchKey(searchKey: Buffer, matterId: string): Buffer {
  assertKey(searchKey)
  if (matterId.length === 0) {
    throw new CryptoInvariantError('Matter identifier must be non-empty')
  }
  return createHmac('sha256', searchKey).update(`matter-search:${matterId}`, 'utf8').digest()
}

export function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function assertKey(key: Buffer): void {
  if (key.length !== MIN_KEY_LENGTH) {
    throw new CryptoInvariantError('V1 keys must be exactly 32 bytes')
  }
}

function assertContext(context: Buffer): void {
  if (context.length === 0) {
    throw new CryptoInvariantError('encrypted fields require a non-empty authenticated context')
  }
}
