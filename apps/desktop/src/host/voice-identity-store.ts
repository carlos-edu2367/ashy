import fs from 'node:fs'
import path from 'node:path'
import type { ConfigDiagnostics } from '@ashy/shared'
import { readWithAutoHeal, writeAtomicWithBackup } from './atomic-file'

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

export interface VoiceIdentitySnapshot {
  content: string
  diagnostics: ConfigDiagnostics
  updatedAt: number
}

export interface VoiceIdentityStore {
  readonly filePath: string
  read(): VoiceIdentitySnapshot
  save(content: string): VoiceIdentitySnapshot
  reset(): VoiceIdentitySnapshot
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

export function createVoiceIdentityStore(options: { userDataDir: string }): VoiceIdentityStore {
  const filePath = path.join(options.userDataDir, 'voice.md')

  function read(): VoiceIdentitySnapshot {
    const result = readWithAutoHeal({
      filePath,
      defaultContent: DEFAULT_ASHY_VOICE_MD,
      parseAndValidate: validateVoiceMarkdown,
    })
    let updatedAt = result.diagnostics.updatedAt
    try {
      updatedAt = Math.floor(fs.statSync(filePath).mtimeMs)
    } catch {
      // keep diagnostics timestamp
    }
    return {
      content: result.value,
      diagnostics: result.diagnostics,
      updatedAt,
    }
  }

  function save(content: string): VoiceIdentitySnapshot {
    const validated = validateVoiceMarkdown(content)
    writeAtomicWithBackup(filePath, validated)
    const now = Date.now()
    return {
      content: validated,
      diagnostics: {
        status: 'ok',
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  function reset(): VoiceIdentitySnapshot {
    writeAtomicWithBackup(filePath, DEFAULT_ASHY_VOICE_MD)
    const now = Date.now()
    return {
      content: DEFAULT_ASHY_VOICE_MD,
      diagnostics: {
        status: 'ok',
        message: 'Identidade de voz restaurada para o padrão Cozy Night Studio.',
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  return {
    filePath,
    read,
    save,
    reset,
  }
}
