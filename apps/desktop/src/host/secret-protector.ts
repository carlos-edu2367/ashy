import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface SecretProtector {
  encrypt(plainText: string): string
  decrypt(cipherTextBase64: string): string
  encryptEnvelope(plainText: string, aad?: string): string
  decryptEnvelope(payload: string, aad?: string): string
  getBackendKind(): 'electron-safe-storage' | 'node-aes-master-key'
}

function encryptRawWithDek(keyBytes: Buffer, plainText: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

function decryptRawWithDek(keyBytes: Buffer, cipherTextBase64: string): string {
  if (typeof cipherTextBase64 !== 'string' || cipherTextBase64.trim().length === 0) {
    throw new Error('Invalid encrypted secret payload')
  }
  const packed = Buffer.from(cipherTextBase64, 'base64')
  if (packed.length < 28) {
    throw new Error('Invalid encrypted secret payload')
  }
  const iv = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const data = packed.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return decrypted.toString('utf8')
}

function encryptEnvelopeWithDek(keyBytes: Buffer, plainText: string, aad = ''): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv)
  if (aad.length > 0) {
    cipher.setAAD(Buffer.from(aad, 'utf8'))
  }
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`
}

function decryptEnvelopeWithDek(keyBytes: Buffer, payload: string, aad = ''): string {
  if (typeof payload !== 'string' || !payload.startsWith('enc:v1:')) {
    return payload
  }
  const rawBase64 = payload.slice('enc:v1:'.length).trim()
  if (!rawBase64) {
    throw new Error('Invalid encrypted envelope payload: empty ciphertext')
  }
  const packed = Buffer.from(rawBase64, 'base64')
  if (packed.length < 28) {
    throw new Error('Invalid encrypted envelope payload: truncated ciphertext')
  }
  const iv = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const data = packed.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv)
  if (aad.length > 0) {
    decipher.setAAD(Buffer.from(aad, 'utf8'))
  }
  decipher.setAuthTag(tag)
  try {
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
    return decrypted.toString('utf8')
  } catch (err) {
    throw new Error(
      `AES-256-GCM envelope authentication or AAD verification failed${aad ? ` (${aad})` : ''}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function createNodeAesSecretProtector(userDataDir: string): SecretProtector {
  fs.mkdirSync(userDataDir, { recursive: true })
  const keyPath = path.join(userDataDir, '.master.key')

  let keyBytes: Buffer
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim()
    keyBytes = Buffer.from(raw, 'base64')
    if (keyBytes.length !== 32) {
      keyBytes = crypto.randomBytes(32)
      fs.writeFileSync(keyPath, keyBytes.toString('base64'), { mode: 0o600 })
    }
  } else {
    keyBytes = crypto.randomBytes(32)
    fs.writeFileSync(keyPath, keyBytes.toString('base64'), { mode: 0o600 })
  }

  return {
    encrypt(plainText: string): string {
      return encryptRawWithDek(keyBytes, plainText)
    },
    decrypt(cipherTextBase64: string): string {
      return decryptRawWithDek(keyBytes, cipherTextBase64)
    },
    encryptEnvelope(plainText: string, aad = ''): string {
      return encryptEnvelopeWithDek(keyBytes, plainText, aad)
    },
    decryptEnvelope(payload: string, aad = ''): string {
      return decryptEnvelopeWithDek(keyBytes, payload, aad)
    },
    getBackendKind(): 'node-aes-master-key' {
      return 'node-aes-master-key'
    },
  }
}

export function createElectronSafeStorageProtector(
  safeStorage: {
    isEncryptionAvailable(): boolean
    encryptString(plainText: string): Buffer
    decryptString(encrypted: Buffer): string
  },
  fallbackUserDataDir: string,
): SecretProtector {
  fs.mkdirSync(fallbackUserDataDir, { recursive: true })
  const dpapiKeyPath = path.join(fallbackUserDataDir, '.master.key.dpapi')
  const legacyKeyPath = path.join(fallbackUserDataDir, '.master.key')

  let wrappedDekBytes: Buffer | null = null
  let lazyFallback: SecretProtector | null = null

  function getOrInitWrappedDek(): Buffer {
    if (wrappedDekBytes && wrappedDekBytes.length === 32) {
      return wrappedDekBytes
    }

    if (fs.existsSync(dpapiKeyPath)) {
      const raw = fs.readFileSync(dpapiKeyPath, 'utf8').trim()
      const unwrappedBase64 = safeStorage.decryptString(Buffer.from(raw, 'base64'))
      const candidate = Buffer.from(unwrappedBase64, 'base64')
      if (candidate.length === 32) {
        wrappedDekBytes = candidate
        if (fs.existsSync(legacyKeyPath)) {
          fs.rmSync(legacyKeyPath, { force: true })
        }
        return wrappedDekBytes
      }
    }

    if (fs.existsSync(legacyKeyPath)) {
      const rawLegacy = fs.readFileSync(legacyKeyPath, 'utf8').trim()
      const candidate = Buffer.from(rawLegacy, 'base64')
      wrappedDekBytes = candidate.length === 32 ? candidate : crypto.randomBytes(32)
      const wrapped = safeStorage.encryptString(wrappedDekBytes.toString('base64')).toString('base64')
      fs.writeFileSync(dpapiKeyPath, wrapped, { mode: 0o600 })
      fs.rmSync(legacyKeyPath, { force: true })
      return wrappedDekBytes
    }

    wrappedDekBytes = crypto.randomBytes(32)
    const wrapped = safeStorage.encryptString(wrappedDekBytes.toString('base64')).toString('base64')
    fs.writeFileSync(dpapiKeyPath, wrapped, { mode: 0o600 })
    return wrappedDekBytes
  }

  function getFallback(): SecretProtector {
    if (!lazyFallback) {
      lazyFallback = createNodeAesSecretProtector(fallbackUserDataDir)
    }
    return lazyFallback
  }

  // Initialize wrapped DEK immediately on construction when safeStorage is available
  // so legacy .master.key is migrated and deleted right away without ever creating a new plaintext .master.key.
  if (safeStorage.isEncryptionAvailable()) {
    getOrInitWrappedDek()
  } else {
    getFallback()
  }

  return {
    encrypt(plainText: string): string {
      if (safeStorage.isEncryptionAvailable()) {
        return `el:${safeStorage.encryptString(plainText).toString('base64')}`
      }
      return `aes:${getFallback().encrypt(plainText)}`
    },
    decrypt(cipherText: string): string {
      if (typeof cipherText !== 'string' || cipherText.trim().length === 0) {
        throw new Error('Invalid encrypted secret payload')
      }
      if (cipherText.startsWith('el:')) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('Electron safeStorage is not available to decrypt secret')
        }
        return safeStorage.decryptString(Buffer.from(cipherText.slice(3), 'base64'))
      }
      const rawAesPayload = cipherText.startsWith('aes:') ? cipherText.slice(4) : cipherText
      if (safeStorage.isEncryptionAvailable()) {
        return decryptRawWithDek(getOrInitWrappedDek(), rawAesPayload)
      }
      return getFallback().decrypt(rawAesPayload)
    },
    encryptEnvelope(plainText: string, aad = ''): string {
      if (safeStorage.isEncryptionAvailable()) {
        return encryptEnvelopeWithDek(getOrInitWrappedDek(), plainText, aad)
      }
      return getFallback().encryptEnvelope(plainText, aad)
    },
    decryptEnvelope(payload: string, aad = ''): string {
      if (safeStorage.isEncryptionAvailable()) {
        return decryptEnvelopeWithDek(getOrInitWrappedDek(), payload, aad)
      }
      return getFallback().decryptEnvelope(payload, aad)
    },
    getBackendKind(): 'electron-safe-storage' | 'node-aes-master-key' {
      return safeStorage.isEncryptionAvailable() ? 'electron-safe-storage' : 'node-aes-master-key'
    },
  }
}
