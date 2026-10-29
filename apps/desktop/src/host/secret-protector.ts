import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface SecretProtector {
  encrypt(plainText: string): string
  decrypt(cipherTextBase64: string): string
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
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv)
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, tag, encrypted]).toString('base64')
    },
    decrypt(cipherTextBase64: string): string {
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
  const fallback = createNodeAesSecretProtector(fallbackUserDataDir)
  return {
    encrypt(plainText: string): string {
      if (safeStorage.isEncryptionAvailable()) {
        return `el:${safeStorage.encryptString(plainText).toString('base64')}`
      }
      return `aes:${fallback.encrypt(plainText)}`
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
      if (cipherText.startsWith('aes:')) {
        return fallback.decrypt(cipherText.slice(4))
      }
      return fallback.decrypt(cipherText)
    },
  }
}
