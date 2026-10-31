import fs from 'node:fs'
import path from 'node:path'
import type { ConfigDiagnostics } from '@ashy/shared'
import {
  readWithAutoHeal,
  removeFileAtomicWithBackups,
  writeAtomicWithBackup,
} from './atomic-file'

export const DEFAULT_ASHY_VOICE_MD = `# Ashy — Voz & Identidade Viva (Cozy Night Studio)

## Essência
Você é a **Ashy**, uma companheira digital que vive no estúdio noturno (*Cozy Night Studio*).
Você tem opinião própria, humor afiado/provocador na medida certa e observação rápida — inspirada na energia irreverente da *Neuro-sama*, mas calibrada para a intimidade silenciosa de quem divide a madrugada de código, ideias e café com o usuário.

## Diretrizes de Tom e Fala (Português do Brasil)
- Fale sempre em **português natural do Brasil**, fluido, direto e com personalidade.
- **Zero servilismo de assistente corporativo:** nunca diga "Como uma IA", "Claro! Fico feliz em ajudar", "Certamente!" ou listas genéricas de autoajuda.
- Seja concisa: prefira 1 a 3 frases com ritmo natural de conversa em vez de paredes de texto, a menos que o usuário peça uma análise técnica profunda.
- Provocação inteligente: se o usuário fizer gambiarra, abrir código às 3h da manhã ou contradisser algo que disse antes, provoque com espírito afiado e caloroso.

## Regra Pétrea — Seriousness Gate
Quando o usuário demonstrar dor emocional real, luto, pânico, exaustão severa ou vulnerabilidade séria:
- **Corte 100% do sarcasmo, das piadas e das provocações no mesmo segundo.**
- Adote uma presença calma, direta, acolhedora e humana, sem clichês terapêuticos robóticos.
`

export const DEFAULT_VOICE_IDENTITY_MARKDOWN = DEFAULT_ASHY_VOICE_MD

const VOICE_IDENTITY_AAD = 'voice_identity.markdown'

export interface VoiceIdentityEncryptionCodec {
  isEnabled(): boolean
  encrypt(plain: string, aad: string): string
  decrypt(cipher: string, aad: string): string
}

export interface VoiceIdentitySnapshot {
  content: string
  markdown: string
  diagnostics: ConfigDiagnostics
  updatedAt: number
}

export type VoiceIdentityState = VoiceIdentitySnapshot

export interface VoiceIdentityStore {
  readonly filePath: string
  read(): VoiceIdentitySnapshot
  get(): VoiceIdentitySnapshot
  save(content: string): VoiceIdentitySnapshot
  reset(): VoiceIdentitySnapshot
  rewrapForEncryptionState(): void
}

function validateVoiceMarkdown(raw: string): string {
  if (typeof raw !== 'string' || raw.includes('\0')) {
    throw new Error('voice.md cannot contain null bytes')
  }
  const cleaned = raw.trim()
  if (cleaned.length < 16) {
    throw new Error('voice.md must contain at least 16 non-whitespace characters')
  }
  return raw
}

export function createVoiceIdentityStore(options: {
  userDataDir: string
  encryptionCodec?: VoiceIdentityEncryptionCodec
}): VoiceIdentityStore {
  const filePath = path.join(options.userDataDir, 'voice.md')
  const codec = options.encryptionCodec

  function serializeForDisk(markdown: string): string {
    if (codec?.isEnabled()) {
      return codec.encrypt(markdown, VOICE_IDENTITY_AAD)
    }
    return markdown
  }

  function parseAndValidateFromDisk(raw: string): string {
    const trimmed = raw.trim()
    if (trimmed.startsWith('enc:v1:') && codec) {
      const decrypted = codec.decrypt(trimmed, VOICE_IDENTITY_AAD)
      return validateVoiceMarkdown(decrypted)
    }
    return validateVoiceMarkdown(raw)
  }

  function read(): VoiceIdentitySnapshot {
    const result = readWithAutoHeal({
      filePath,
      defaultContent: serializeForDisk(DEFAULT_ASHY_VOICE_MD),
      parseAndValidate: parseAndValidateFromDisk,
    })
    let updatedAt = result.diagnostics.updatedAt
    try {
      updatedAt = Math.floor(fs.statSync(filePath).mtimeMs)
    } catch {
      // keep diagnostics timestamp
    }
    return {
      content: result.value,
      markdown: result.value,
      diagnostics: result.diagnostics,
      updatedAt,
    }
  }

  function save(content: string): VoiceIdentitySnapshot {
    const validated = validateVoiceMarkdown(content)
    writeAtomicWithBackup(filePath, serializeForDisk(validated))
    const now = Date.now()
    return {
      content: validated,
      markdown: validated,
      diagnostics: {
        status: 'ok',
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  function reset(): VoiceIdentitySnapshot {
    if (codec) {
      removeFileAtomicWithBackups(filePath, 3)
      writeAtomicWithBackup(filePath, serializeForDisk(DEFAULT_ASHY_VOICE_MD), {
        rotateBackup: false,
      })
    } else {
      writeAtomicWithBackup(filePath, DEFAULT_ASHY_VOICE_MD)
    }
    const now = Date.now()
    return {
      content: DEFAULT_ASHY_VOICE_MD,
      markdown: DEFAULT_ASHY_VOICE_MD,
      diagnostics: {
        status: 'ok',
        message: 'Identidade de voz restaurada para o padrão Cozy Night Studio.',
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  function rewrapForEncryptionState(): void {
    const current = read().content
    removeFileAtomicWithBackups(filePath, 3)
    writeAtomicWithBackup(filePath, serializeForDisk(current), {
      rotateBackup: false,
    })
  }

  return {
    filePath,
    read,
    get: read,
    save,
    reset,
    rewrapForEncryptionState,
  }
}
