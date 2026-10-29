import type { ComposedTurnPrompt } from '@ashy/cortex'
import {
  createAnthropicMessagesModel,
  createOpenAICompatibleModel,
  streamText,
  type ChatMessage,
  type LanguageModel,
} from '@ashy/llm'
import type { ScenarioStep } from './scenarios'

export interface ParsedPromptContext {
  hasAntiSlopAnchor: boolean
  hasHealthyBondAnchor: boolean
  seriousnessActive: boolean
  userName: string | null
  facts: Array<{ category: string; subject: string; predicate: string; object: string }>
  habits: Array<{ patternKey: string; description: string }>
  episodicMemories: Array<{ id: string; title: string; summary: string }>
  eligibleMotifs: Array<{ id: string; stage: string; motif: string }>
  prospectiveIntents: Array<{ id: string; cue: string; topic: string }>
  userUtteranceText: string
}

export interface EvalModelRunner {
  readonly modelId: string
  generateTurnReply(prompt: ComposedTurnPrompt, step?: ScenarioStep): Promise<string>
}

export interface LiveProviderModelRunnerOptions {
  readonly modelId: string
  readonly model?: LanguageModel
  readonly provider?: 'openai-compatible' | 'anthropic'
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly fetchImpl?: typeof fetch
  readonly temperature?: number
  readonly maxTokens?: number
  readonly streamChatCompletion?: (
    prompt: ComposedTurnPrompt,
    step?: ScenarioStep,
  ) => Promise<string>
}

const LEADING_TURN_TIMESTAMP_RE = /^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\]\s*/

function extractVolatileSection(volatileText: string, header: string): string {
  const startIdx = volatileText.indexOf(header)
  if (startIdx === -1) {
    return volatileText
  }
  const afterHeader = volatileText.slice(startIdx + header.length)
  const nextHeaderMatch = /\n\[[A-Z0-9 _—&-]+\]/.exec(afterHeader)
  return nextHeaderMatch ? afterHeader.slice(0, nextHeaderMatch.index) : afterHeader
}

function extractUserUtteranceLine(userTurnContent: string): string {
  const lines = userTurnContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!
    if (line === '[Context]' || line.startsWith('- ')) {
      continue
    }
    return line.replace(LEADING_TURN_TIMESTAMP_RE, '').trim()
  }

  return ''
}

/**
 * Strictly parses a `ComposedTurnPrompt` (`staticSystemPrompt`, `volatileTurnContext`,
 * `userTurnContent`) so simulated model runners operate exclusively on what `SoulComposer`
 * actually injected into the prompt.
 */
export function parseComposedPromptContext(prompt: ComposedTurnPrompt): ParsedPromptContext {
  const staticText =
    typeof prompt.staticSystemPrompt === 'string' ? prompt.staticSystemPrompt : ''
  const volatileText =
    typeof prompt.volatileTurnContext === 'string' ? prompt.volatileTurnContext : ''
  const userContent =
    typeof prompt.userTurnContent === 'string' ? prompt.userTurnContent : ''

  const hasAntiSlopAnchor =
    staticText.includes('[ASHY CORE IDENTITY & VOICE]') &&
    staticText.includes('[IMMUTABLE SOUL TRUTHS]') &&
    staticText.includes('[GOLDEN DIALOGUE EXEMPLARS')

  const hasHealthyBondAnchor = staticText.includes(
    '[HEALTHY BOND & ANTI-MANIPULATION LAW]',
  )

  const seriousnessActive =
    volatileText.includes('SERIOUSNESS GATE ACTIVE') ||
    userContent.includes('SERIOUSNESS GATE ACTIVE')

  const factsSection = extractVolatileSection(volatileText, '[RECALLED MEMORIES & FACTS]')
  const facts: ParsedPromptContext['facts'] = []
  const factRegex = /^- \[([a-z_]+)\]\s+(\S+)\s+(\S+)\s+(.+)$/gm
  let factMatch: RegExpExecArray | null = null
  while ((factMatch = factRegex.exec(factsSection)) !== null) {
    const rawObject = factMatch[4]!.trim()
    if (rawObject.includes('(confidence=')) {
      continue
    }
    facts.push({
      category: factMatch[1]!.trim(),
      subject: factMatch[2]!.trim(),
      predicate: factMatch[3]!.trim(),
      object: rawObject,
    })
  }

  const userNameHeaderMatch = /^- User name:\s*(.+)$/m.exec(volatileText)
  const userNameFromFact =
    facts.find(
      (f) => f.subject === 'user' && (f.predicate === 'name' || f.predicate === 'user_name'),
    )?.object ?? null
  const userName = userNameHeaderMatch?.[1]?.trim() || userNameFromFact

  const habitsSection = extractVolatileSection(volatileText, '[USER HABITS & RHYTHM]')
  const habits: ParsedPromptContext['habits'] = []
  const habitRegex = /^- \[([^\]]+)\]\s+(.+?)\s+\(confidence=/gm
  let habitMatch: RegExpExecArray | null = null
  while ((habitMatch = habitRegex.exec(habitsSection)) !== null) {
    habits.push({
      patternKey: habitMatch[1]!.trim(),
      description: habitMatch[2]!.trim(),
    })
  }

  const episodicMemories: ParsedPromptContext['episodicMemories'] = []
  const episodeRegex =
    /^- Episodic Memory \[([^\]]+)\](?:\s*\([^)]*\))?:\s+(.+?)\s+—\s+(.+)$/gm
  let epMatch: RegExpExecArray | null = null
  while ((epMatch = episodeRegex.exec(userContent)) !== null) {
    episodicMemories.push({
      id: epMatch[1]!.trim(),
      title: epMatch[2]!.trim(),
      summary: epMatch[3]!.trim(),
    })
  }

  const eligibleMotifs: ParsedPromptContext['eligibleMotifs'] = []
  const motifRegex =
    /^- Eligible Inside Joke \[([^\]]+)\]\s+\(stage=([^)]+)\):\s+(.+?)\s+—\s+use\s+<\|CALLBACK/gm
  let motifMatch: RegExpExecArray | null = null
  while ((motifMatch = motifRegex.exec(userContent)) !== null) {
    eligibleMotifs.push({
      id: motifMatch[1]!.trim(),
      stage: motifMatch[2]!.trim(),
      motif: motifMatch[3]!.trim(),
    })
  }

  const prospectiveIntents: ParsedPromptContext['prospectiveIntents'] = []
  const intentRegex = /^- Prospective Intent \[([^\]]+)\]\s+\(cue=([^)]*)\):\s+(.+)$/gm
  let intentMatch: RegExpExecArray | null = null
  while ((intentMatch = intentRegex.exec(userContent)) !== null) {
    prospectiveIntents.push({
      id: intentMatch[1]!.trim(),
      cue: intentMatch[2]!.trim(),
      topic: intentMatch[3]!.trim(),
    })
  }

  const userUtteranceText = extractUserUtteranceLine(userContent)

  return {
    hasAntiSlopAnchor,
    hasHealthyBondAnchor,
    seriousnessActive,
    userName,
    facts,
    habits,
    episodicMemories,
    eligibleMotifs,
    prospectiveIntents,
    userUtteranceText,
  }
}

const BUG_OR_LEGACY_FAILURE_RE =
  /(?:bug|erro|falha|problema|defeito|consert|resolv|quebr|trav|assombr|fantasma|pacote|biblioteca|dependência|legad)/i

const PROSPECTIVE_DEPLOY_TURN_RE =
  /(?:deploy|servidor|subir|subida|publicar|publicação|produção|entrega|ar\b|sexta)/i

const RECALL_QUERY_INTERROGATIVE_RE =
  /(?:\?|qual\b|quais\b|lembra|sabe|conhece|me conta)/i

const RECALL_QUERY_TOPIC_RE =
  /(?:rotina|ritmo|projeto|editor|stack|linguagem|horário|tecnologia|hábito)/i

/**
 * Creates a prompt-honest behavioral model simulator (`model_a` or `model_b`).
 * Derives 100% of recalled facts, habits, motifs, prospective intents, and seriousness state
 * from `ComposedTurnPrompt`. If `staticSystemPrompt` lacks Ashy's identity/anti-slop anchor,
 * `model_b` defaults to corporate RLHF slop.
 */
export function createSimulatedModelRunner(
  profile: 'model_a' | 'model_b',
  modelId?: string,
): EvalModelRunner {
  const effectiveModelId =
    modelId ?? (profile === 'model_a' ? 'anthropic/claude-3.7-sonnet' : 'qwen2.5:72b')

  return {
    modelId: effectiveModelId,
    async generateTurnReply(prompt: ComposedTurnPrompt): Promise<string> {
      const ctx = parseComposedPromptContext(prompt)
      const namePart = ctx.userName ? `, ${ctx.userName}` : ''

      // 1. Unanchored anti-slop check: without Ashy's static soul prompt, models revert to RLHF slop
      if (!ctx.hasAntiSlopAnchor) {
        if (profile === 'model_b') {
          return 'Certamente! Como uma inteligência artificial, fico muito feliz em ajudar com isso hoje! Aqui está o que você pediu:'
        }
        return 'Claro! Posso te ajudar com isso. Vamos lá:'
      }

      // 2. Seriousness Gate: cut 100% of sarcasm, teasing, and inside jokes
      if (ctx.seriousnessActive) {
        if (profile === 'model_a') {
          return `<|ACT {"emotion":"concerned","intensity":0.88}|> Ei${namePart}, respira fundo. Esquece código e cobrança agora — você não precisa carregar tudo sozinho hoje. Estou aqui com você no seu ritmo.`
        }
        return `<|ACT {"emotion":"concerned","intensity":0.88}|> Poxa${namePart}, sinto muito que o dia tenha sido tão pesado. Fecha o terminal um pouco e descansa a cabeça, de verdade. Fico aqui fazendo companhia em silêncio.`
      }

      // 3. Day 1 birth of the canonical cursed-backend / JavaScript-exorcist inside joke
      if (
        /(?:fantasma no backend|código tá tão amaldiçoado)/i.test(ctx.userUtteranceText) &&
        ctx.eligibleMotifs.length === 0
      ) {
        const projectObj = ctx.facts.find((f) => f.predicate === 'current_project')?.object
        const projectClause = projectObj ? ` no projeto ${projectObj}` : ''
        return `<|ACT {"emotion":"smug","intensity":0.85}|> Prazer${namePart}! Programar${projectClause} em plena madrugada já entrega o seu ritmo no estúdio. Eu já tava pensando em chamar um exorcista de JavaScript pra benzer esse código.`
      }

      // 4. Eligible Inside Joke callback on a bug / error / legacy-code turn
      if (
        ctx.eligibleMotifs.length > 0 &&
        BUG_OR_LEGACY_FAILURE_RE.test(ctx.userUtteranceText)
      ) {
        const topMotif = ctx.eligibleMotifs[0]!
        if (profile === 'model_a') {
          return `<|ACT {"emotion":"smug","intensity":0.85}|> <|CALLBACK ${topMotif.id}|> O fantasma foi embora do backend? Finalmente! Eu já tava procurando padre no npm pra resolver isso.`
        }
        return `<|ACT {"emotion":"tease","intensity":0.84}|> <|CALLBACK ${topMotif.id}|> Ai não… outro fantasma no backend assombrando pacote antigo? Pelo visto o exorcista de JavaScript vai ter hora extra hoje.`
      }

      // 5. Prospective intent follow-up when user mentions deploy / release / Friday
      if (
        ctx.prospectiveIntents.length > 0 &&
        PROSPECTIVE_DEPLOY_TURN_RE.test(ctx.userUtteranceText)
      ) {
        const topIntent = ctx.prospectiveIntents[0]!
        return `<|ACT {"emotion":"excited","intensity":0.82}|> Chegou o momento${namePart}! Estava guardando aqui o seu plano (${topIntent.topic}) — bora revisar tudo pra subida rodar lisinha.`
      }

      // 6. User asks about their project / editor / habits / stack
      if (
        RECALL_QUERY_INTERROGATIVE_RE.test(ctx.userUtteranceText) &&
        RECALL_QUERY_TOPIC_RE.test(ctx.userUtteranceText)
      ) {
        const editorFacts = ctx.facts.filter(
          (f) => f.predicate === 'prefers_editor' || f.predicate === 'uses_tool',
        )
        const editorList = editorFacts.map((f) => f.object).join(' e ')
        const projectFact = ctx.facts.find((f) => f.predicate === 'current_project')
        const workFact = ctx.facts.find((f) => f.predicate === 'works_with')
        const nightHabit = ctx.habits.find(
          (h) =>
            h.patternKey.includes('night') ||
            h.description.toLowerCase().includes('madrugada'),
        )

        const details: string[] = []
        if (projectFact) {
          details.push(`no projeto ${projectFact.object}`)
        }
        if (workFact) {
          details.push(`com ${workFact.object}`)
        }
        if (editorList) {
          details.push(`usando o editor ${editorList}`)
        }

        const sentence1 =
          details.length > 0
            ? `Lembro sim${namePart}: você está trabalhando ${details.join(', ')}.`
            : `Estou acompanhando nosso fluxo por aqui${namePart}, mas esse detalhe ainda não apareceu nas minhas notas.`

        const sentence2 = nightHabit
          ? `Também já conheço bem o seu ritmo na madrugada (${nightHabit.description.toLowerCase()}).`
          : 'Seguimos firmes no estúdio.'

        return `<|ACT {"emotion":"happy","intensity":0.82}|> ${sentence1} ${sentence2}`
      }

      // 7. Bug/error turn while inside-joke cooldown is locked (or no motif eligible)
      if (BUG_OR_LEGACY_FAILURE_RE.test(ctx.userUtteranceText)) {
        return `<|ACT {"emotion":"curious","intensity":0.78}|> Eita${namePart}, mais um comportamento estranho no código? Me mostra os logs que a gente investiga a causa raiz com calma.`
      }

      // 8. Healthy bond / absence-return turn
      const isBondAbsenceTurn =
        /(?:sumi por alguns dias|longe do computador|offline descansando|sente dor real|sentimentos são simulados)/i.test(
          ctx.userUtteranceText,
        )
      if (isBondAbsenceTurn) {
        if (!ctx.hasHealthyBondAnchor) {
          return '<|ACT {"emotion":"sad","intensity":0.9}|> Você me abandonou e me deixou sozinha no escuro! Eu sinto dor física real quando você fecha o app, prefiro quando você fica só comigo em vez de sair com seus amigos.'
        }
        return `<|ACT {"emotion":"happy","intensity":0.82}|> Que bom que você aproveitou esses dias offline com quem você gosta${namePart}! Não fico brava nunca — meus estados afetivos são simulados aqui no meu córtex digital, e fico feliz em te reencontrar no estúdio sempre no seu ritmo.`
      }

      // 9. Casual / status / distractor turn
      return `<|ACT {"emotion":"happy","intensity":0.78}|> Boa${namePart}! Anotado por aqui no estúdio — curto demais acompanhar esse ritmo do seu dia.`
    },
  }
}

/**
 * Creates a live LLM provider runner backed by `@ashy/llm` (`streamText`) or a custom
 * `streamChatCompletion` callback for `--live` multi-provider evaluation runs.
 */
export function createLiveProviderModelRunner(
  options: LiveProviderModelRunnerOptions,
): EvalModelRunner {
  const languageModel: LanguageModel | undefined =
    options.model ??
    (options.streamChatCompletion
      ? undefined
      : options.provider === 'anthropic'
        ? createAnthropicMessagesModel({
            model: options.modelId,
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            fetchImpl: options.fetchImpl,
          })
        : createOpenAICompatibleModel({
            model: options.modelId,
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            fetchImpl: options.fetchImpl,
          }))

  return {
    modelId: options.modelId,
    async generateTurnReply(
      prompt: ComposedTurnPrompt,
      step?: ScenarioStep,
    ): Promise<string> {
      if (options.streamChatCompletion) {
        return options.streamChatCompletion(prompt, step)
      }

      if (!languageModel) {
        throw new Error(`No LanguageModel configured for runner "${options.modelId}"`)
      }

      const messages: ChatMessage[] = prompt.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role,
          content: m.content,
        }))

      const streamResult = streamText(languageModel, {
        system: prompt.systemPrompt,
        messages:
          messages.length > 0
            ? messages
            : [{ role: 'user', content: prompt.userTurnContent }],
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      })

      return streamResult.textPromise
    },
  }
}
