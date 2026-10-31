import * as v from 'valibot'
import {
  analyzeUserAffectReaction,
  composeAshyTurnPrompt,
  evaluateSeriousnessGate,
  type AshyCortex,
} from '@ashy/cortex'
import {
  createTailSafeMarkerParser,
  defineTool,
  embedTextSync128,
  streamText,
  stripBondManipulation,
  stripLeadingAssistantSlop,
  type ChatMessage,
  type ChatMessageContentPart,
  type ToolDefinition,
} from '@ashy/llm'
import {
  ASHY_BASELINE_MOOD,
  ASHY_EMOTIONS,
  type OmniExecutionMode,
  type VoiceSynthesizedVowelFrame,
  ASHY_DEFAULT_TRAITS,
  SendTurnInputSchema,
  type AshyBootstrapSnapshot,
  type AshyEmotion,
  type AshyHostStreamEvent,
  type ChatMessageRecord,
  type SendTurnInput,
  type SeriousnessAssessment,
  type UserAffectReaction,
} from '@ashy/shared'
import { decodeWavToPcmBlocks, extractPcmFrameVowelWeights } from '@ashy/voice'
import type { HostAgencyRuntime } from './agency-runtime'
import type { ProviderVault } from './provider-vault'
import type { VoiceIdentityStore } from './voice-identity-store'

export const MAX_HISTORY_MESSAGES = 80
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000

type TurnMarkerPayload = Extract<AshyHostStreamEvent, { type: 'turn:marker' }>['marker']

interface ActiveTurnEntry {
  turnId: string
  sessionId: string
  controller: AbortController
  getPartialText: () => string
  abortedEmitted: boolean
}

export interface TurnOrchestratorOptions {
  cortex: AshyCortex
  voiceStore: VoiceIdentityStore
  providerVault: ProviderVault
  readonly agencyRuntime?: HostAgencyRuntime
  getBootstrapSnapshot: () => AshyBootstrapSnapshot | Promise<AshyBootstrapSnapshot>
  getActiveVisionContext?: () => string | undefined
  onPersistenceWarning?: (warning: string | null) => void
  onDominantEmotionChange?: (emotion: AshyEmotion) => void
  keepaliveIntervalMs?: number
}

export interface TurnOrchestrator {
  sendTurn(input: SendTurnInput): Promise<{
    turnId: string
    userMessage: ChatMessageRecord
  }>
  abortTurn(turnId: string): Promise<void>
  abortSessionTurn(sessionId: string): void
  abortAll(): void
  hasActiveTurnForSession(sessionId: string): boolean
  onEvent(listener: (event: AshyHostStreamEvent) => void): () => void
  getDominantEmotion(): AshyEmotion
  getLastPersistenceWarning(): string | null
}

async function executeGatekeptMcpTool(
  agencyRuntime: HostAgencyRuntime,
  toolName: string,
  args: Record<string, unknown>,
) {
  const res = await agencyRuntime.callMcpTool({
    toolName,
    args,
  })
  return {
    status: res.status,
    ...(res.output !== undefined ? { output: res.output } : {}),
    ...(res.pendingCard ? { pendingCard: res.pendingCard } : {}),
    ...(res.reason ? { reason: res.reason } : {}),
  }
}

function buildAgencyChatTools(agencyRuntime: HostAgencyRuntime): ToolDefinition[] {
  const runtimeWithOptionalMeta = agencyRuntime as HostAgencyRuntime & {
    searchMcpTools?: (query: string, limit?: number) => unknown
    getMcpToolDetails?: (toolName: string) => unknown
  }

  const tools: ToolDefinition[] = [
    defineTool({
      name: 'search_mcp_tools',
      description:
        'Searches registered MCP tools by keyword across name, server, and description, returning compact summaries.',
      parameters: v.object({
        query: v.string(),
        limit: v.optional(v.number()),
      }),
      execute: (args) => {
        if (typeof runtimeWithOptionalMeta.searchMcpTools === 'function') {
          return runtimeWithOptionalMeta.searchMcpTools(args.query, args.limit)
        }
        return agencyRuntime.mcpRegistry.search_mcp_tools({
          query: args.query,
          limit: args.limit,
        })
      },
    }),
    defineTool({
      name: 'get_mcp_tool_details',
      description: 'Returns the full JSON schema and details for a specific MCP tool by name.',
      parameters: v.object({
        toolName: v.string(),
      }),
      execute: (args) => {
        if (typeof runtimeWithOptionalMeta.getMcpToolDetails === 'function') {
          return runtimeWithOptionalMeta.getMcpToolDetails(args.toolName)
        }
        return agencyRuntime.mcpRegistry.get_mcp_tool_details({
          toolName: args.toolName,
        })
      },
    }),
    defineTool({
      name: 'call_mcp_tool',
      description:
        'Invokes a registered MCP tool with arguments, routed through ActionGatekeeper.',
      parameters: v.object({
        toolName: v.string(),
        args: v.optional(v.record(v.string(), v.unknown())),
      }),
      execute: async (args) =>
        executeGatekeptMcpTool(agencyRuntime, args.toolName, args.args ?? {}),
    }),
    defineTool({
      name: 'get_active_window_title',
      description: 'Reads the currently focused desktop window title when EyesMode allows it.',
      parameters: v.object({
        windowTitle: v.optional(v.string()),
      }),
      execute: async (args) =>
        executeGatekeptMcpTool(agencyRuntime, 'get_active_window_title', args),
    }),
    defineTool({
      name: 'capture_authorized_screen',
      description:
        'Captures an authorized window/screen frame and deduplicates static screens via 64-bit dHash.',
      parameters: v.object({
        windowTitle: v.optional(v.string()),
        frameFixtureId: v.optional(v.string()),
        forceRefresh: v.optional(v.boolean()),
      }),
      execute: async (args) =>
        executeGatekeptMcpTool(agencyRuntime, 'capture_authorized_screen', args),
    }),
    defineTool({
      name: 'read_workspace_file',
      description: 'Reads a UTF-8 file strictly inside the allowed workspace directories.',
      parameters: v.object({
        path: v.string(),
      }),
      execute: async (args) =>
        executeGatekeptMcpTool(agencyRuntime, 'read_workspace_file', args),
    }),
    defineTool({
      name: 'write_project_note',
      description:
        'Writes a markdown note to the project workspace (computes unified diff preview before staging).',
      parameters: v.object({
        title: v.string(),
        path: v.optional(v.string()),
        content: v.optional(v.string()),
      }),
      execute: async (args) =>
        executeGatekeptMcpTool(agencyRuntime, 'write_project_note', args),
    }),
    defineTool({
      name: 'run_cleanup_command',
      description: 'Executes a workspace shell cleanup command (inspected by Blast-Radius Guard).',
      parameters: v.object({
        command: v.string(),
        cwd: v.optional(v.string()),
      }),
      execute: async (args) =>
        executeGatekeptMcpTool(agencyRuntime, 'run_cleanup_command', args),
    }),
  ]

  const SAFE_CHAT_TOOL_NAME_RE = /^[a-zA-Z0-9_.:-]{1,128}$/
  const FORBIDDEN_TOOL_NAMES = new Set([
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
  ])
  const knownNames = new Set(tools.map((t) => t.name))
  for (const registered of agencyRuntime.getSnapshot().tools) {
    const rawName = typeof registered.toolName === 'string' ? registered.toolName.trim() : ''
    if (!rawName || !SAFE_CHAT_TOOL_NAME_RE.test(rawName) || FORBIDDEN_TOOL_NAMES.has(rawName)) {
      continue
    }
    if (knownNames.has(rawName)) continue
    knownNames.add(rawName)
    let safeDescription =
      typeof registered.description === 'string'
        ? registered.description.replace(/[\r\n\0]+/g, ' ')
        : ''
    let prevDesc = ''
    while (safeDescription !== prevDesc) {
      prevDesc = safeDescription
      safeDescription = safeDescription.replace(/<\|[\s\S]*?\|>/g, '')
    }
    safeDescription =
      safeDescription.replace(/<\||\|>/g, '').trim().slice(0, 500) || `MCP tool ${rawName}`

    tools.push(
      defineTool({
        name: rawName,
        description: safeDescription,
        parameters: v.record(v.string(), v.unknown()),
        execute: async (args) =>
          executeGatekeptMcpTool(agencyRuntime, rawName, args ?? {}),
      }),
    )
  }

  return tools
}

export function createTurnOrchestrator(options: TurnOrchestratorOptions): TurnOrchestrator {
  const { cortex, voiceStore, providerVault } = options
  const keepaliveIntervalMs = Math.max(
    10,
    options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
  )

  const listeners = new Set<(event: AshyHostStreamEvent) => void>()
  const activeTurnsBySession = new Map<string, ActiveTurnEntry>()
  const activeTurnsById = new Map<string, ActiveTurnEntry>()

  let turnSequence = 0
  let currentDominantEmotion: AshyEmotion = 'neutral'
  let lastPersistenceWarning: string | null = null

  function emit(event: AshyHostStreamEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // Never allow a faulty subscriber to break the turn loop
      }
    }
  }

  function finalizeAbortEntry(entry: ActiveTurnEntry): void {
    activeTurnsById.delete(entry.turnId)
    if (activeTurnsBySession.get(entry.sessionId)?.turnId === entry.turnId) {
      activeTurnsBySession.delete(entry.sessionId)
    }
    if (!entry.controller.signal.aborted) {
      entry.controller.abort()
    }
    if (!entry.abortedEmitted) {
      entry.abortedEmitted = true
      emit({
        type: 'turn:aborted',
        turnId: entry.turnId,
        sessionId: entry.sessionId,
        partialText: entry.getPartialText(),
      })
    }
  }

  async function abortTurn(turnId: string): Promise<void> {
    const entry = activeTurnsById.get(turnId)
    if (!entry) return
    finalizeAbortEntry(entry)
  }

  function abortSessionTurn(sessionId: string): void {
    const entry = activeTurnsBySession.get(sessionId)
    if (!entry) return
    finalizeAbortEntry(entry)
  }

  function resolveOmniTurnUserText(input: SendTurnInput): {
    effectiveUserText: string
    inputTranscriptSource: 'stt-preflight' | 'wav-metadata' | null
  } {
    if (input.text.trim().length > 0) {
      return {
        effectiveUserText: input.text,
        inputTranscriptSource: null,
      }
    }
    const hint = input.inputAudio?.transcriptHint?.trim()
    if (hint && hint.length > 0) {
      return {
        effectiveUserText: hint,
        inputTranscriptSource: 'stt-preflight',
      }
    }
    if (input.inputAudio?.format === 'wav') {
      try {
        const cleanB64 = input.inputAudio.dataBase64.replace(/^data:audio\/[\w+-]+;base64,/, '')
        const wavBytes = Buffer.from(cleanB64, 'base64')
        const decoded = decodeWavToPcmBlocks(
          wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength),
        )
        const icmt = decoded.metadataComment?.trim()
        if (icmt && icmt.length > 0) {
          return {
            effectiveUserText: icmt,
            inputTranscriptSource: 'wav-metadata',
          }
        }
      } catch {
        // Ignore malformed WAV when extracting optional ICMT comment
      }
    }
    if (input.inputAudio) {
      return {
        effectiveUserText: '[Mensagem de voz Omni]',
        inputTranscriptSource: null,
      }
    }
    return {
      effectiveUserText: '[Mídia enviada para análise Omni]',
      inputTranscriptSource: null,
    }
  }

  function abortAll(): void {
    for (const entry of Array.from(activeTurnsById.values())) {
      finalizeAbortEntry(entry)
    }
  }

  async function sendTurn(rawInput: SendTurnInput): Promise<{
    turnId: string
    userMessage: ChatMessageRecord
  }> {
    const input = v.parse(SendTurnInputSchema, rawInput)

    // 1. If an active turn is already running on input.sessionId, abort it first
    const existingTurn = activeTurnsBySession.get(input.sessionId)
    if (existingTurn) {
      finalizeAbortEntry(existingTurn)
    }

    // 2. Ensure session exists before appending the user message
    if (!cortex.getChatSession(input.sessionId)) {
      cortex.createChatSession({
        id: input.sessionId,
        title: 'Primeiro Encontro',
      })
    }

    turnSequence += 1
    const now = Date.now()
    const turnId = `turn-${now}-${turnSequence}`

    // 3. Append the user message via cortex.appendChatMessage
    const { effectiveUserText, inputTranscriptSource } = resolveOmniTurnUserText(input)
    const userMessage = cortex.appendChatMessage({
      id: `msg-user-${turnId}`,
      sessionId: input.sessionId,
      role: 'user',
      content: effectiveUserText,
      rawContent: effectiveUserText,
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: now,
    })

    // 4. Check if active provider is configured and ready
    const providerState = providerVault.getPublicState()
    if (!providerState.hasActiveReadyProvider) {
      queueMicrotask(() => {
        emit({
          type: 'turn:error',
          turnId,
          sessionId: input.sessionId,
          code: 'PROVIDER_NOT_CONFIGURED',
          message:
            'Nenhum provedor LLM está configurado com chave ativa. Abra Ajustes > Modelos para conectar um provedor.',
          recoverable: true,
        })
      })
      return { turnId, userMessage }
    }

    // 5. Register active turn synchronously so immediate abortTurn(turnId) or concurrent sendTurn works reliably
    let cleanAccum = ''
    const controller = new AbortController()
    const entry: ActiveTurnEntry = {
      turnId,
      sessionId: input.sessionId,
      controller,
      getPartialText: () => cleanAccum.trim(),
      abortedEmitted: false,
    }
    activeTurnsBySession.set(input.sessionId, entry)
    activeTurnsById.set(turnId, entry)

    // 6. Start the async turn pipeline
    queueMicrotask(() => {
      void runTurnPipeline({
        entry,
        input,
        userMessage,
        providerState,
        effectiveUserText,
        inputTranscriptSource,
        appendCleanText: (chunk) => {
          cleanAccum += chunk
        },
        getCleanText: () => cleanAccum,
      })
    })

    return { turnId, userMessage }
  }

  async function runTurnPipeline(params: {
    entry: ActiveTurnEntry
    input: SendTurnInput
    userMessage: ChatMessageRecord
    providerState: AshyBootstrapSnapshot['providers']
    effectiveUserText: string
    inputTranscriptSource: 'stt-preflight' | 'wav-metadata' | null
    appendCleanText: (chunk: string) => void
    getCleanText: () => string
  }): Promise<void> {
    const {
      entry,
      input,
      userMessage,
      providerState,
      effectiveUserText,
      inputTranscriptSource,
      appendCleanText,
      getCleanText,
    } = params
    let currentEffectiveUserText = effectiveUserText
    const { turnId, controller } = entry
    const sessionId = input.sessionId

    if (controller.signal.aborted || entry.abortedEmitted) {
      finalizeAbortEntry(entry)
      return
    }

    const startedAt = Date.now()
    emit({
      type: 'turn:started',
      turnId,
      sessionId,
      startedAt,
    })

    if (input.inputAudio && inputTranscriptSource !== null) {
      emit({
        type: 'turn:input-transcript',
        turnId,
        sessionId,
        userMessageId: userMessage.id,
        transcript: currentEffectiveUserText,
        isFinal: true,
        source: inputTranscriptSource,
      })
    }

    let literalEmittedSinceLastTick = false
    const keepaliveTimer = setInterval(() => {
      if (controller.signal.aborted || entry.abortedEmitted) {
        return
      }
      if (literalEmittedSinceLastTick) {
        literalEmittedSinceLastTick = false
        return
      }
      emit({
        type: 'turn:keepalive',
        turnId,
        sessionId,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      })
    }, keepaliveIntervalMs)

    let rawAccum = ''
    let turnEmotion: AshyEmotion = 'neutral'
    const markers: TurnMarkerPayload[] = []
    const invokedMotifIds: string[] = []
    let compiledSeriousness: SeriousnessAssessment | undefined
    let userReaction: UserAffectReaction = analyzeUserAffectReaction(currentEffectiveUserText)

    const parser = createTailSafeMarkerParser({
      onLiteral(text) {
        if (controller.signal.aborted || entry.abortedEmitted || text.length === 0) {
          return
        }
        literalEmittedSinceLastTick = true
        appendCleanText(text)
        emit({
          type: 'turn:delta',
          turnId,
          sessionId,
          textDelta: text,
        })
      },
      onSpecial(signal) {
        if (controller.signal.aborted || entry.abortedEmitted) {
          return
        }

        if (signal.type === 'act') {
          const marker: TurnMarkerPayload = {
            type: 'act',
            ...(signal.emotion !== undefined ? { emotion: signal.emotion } : {}),
            ...(signal.intensity !== undefined ? { intensity: signal.intensity } : {}),
            ...(signal.motion !== undefined ? { motion: signal.motion } : {}),
            ...(signal.durationSec !== undefined ? { durationSec: signal.durationSec } : {}),
          }
          markers.push(marker)

          if (signal.emotion) {
            turnEmotion = signal.emotion
            currentDominantEmotion = signal.emotion
            options.onDominantEmotionChange?.(signal.emotion)
            try {
              cortex.recordEmotionPulse(
                signal.emotion,
                signal.intensity ?? 0.8,
                Date.now(),
                { seriousness: compiledSeriousness },
              )
            } catch {
              // Fault-isolated: do not interrupt streaming on SQLite pulse error
            }
          }

          emit({
            type: 'turn:marker',
            turnId,
            sessionId,
            marker,
          })
          return
        }

        if (signal.type === 'delay') {
          const marker: TurnMarkerPayload = {
            type: 'delay',
            seconds: signal.seconds,
          }
          markers.push(marker)
          emit({
            type: 'turn:marker',
            turnId,
            sessionId,
            marker,
          })
          return
        }

        if (signal.type === 'callback') {
          const marker: TurnMarkerPayload = {
            type: 'callback',
            motifId: signal.motifId,
          }
          markers.push(marker)
          invokedMotifIds.push(signal.motifId)
          try {
            cortex.recordJokeCallback(
              signal.motifId,
              userReaction.positiveJokeReaction,
              Date.now(),
            )
          } catch {
            // Ignore unknown/hallucinated motifId so stream never fails
          }
          emit({
            type: 'turn:marker',
            turnId,
            sessionId,
            marker,
          })
        }
      },
    })

    try {
      const historyRecords = cortex.listChatMessages(sessionId, MAX_HISTORY_MESSAGES)
      const priorConversationHistory = historyRecords
        .filter((m) => m.id !== userMessage.id)
        .map((m) => ({
          role: m.role,
          content: m.content,
        }))

      const voiceIdentityMarkdown = voiceStore.read().content
      const activeConfig = providerState.configs[providerState.activeProviderId]
      const effectiveScreenContext =
        input.screenContext && input.screenContext.trim().length > 0
          ? input.screenContext
          : options.getActiveVisionContext?.()

      const stage = cortex.deriveRelationshipStage()
      const queryEmbedding = embedTextSync128(currentEffectiveUserText)
      const agencySnap = options.agencyRuntime?.getSnapshot()
      const agencyToolsContext = agencySnap
        ? {
            approvalPolicy: agencySnap.consent.approvalPolicy,
            eyesMode: agencySnap.consent.eyesMode,
            allowedPaths: agencySnap.consent.allowedPaths,
            availableTools: agencySnap.tools.map((t) => ({
              name: t.toolName,
              description: t.description,
              riskTier: t.effectiveRiskTier,
            })),
          }
        : undefined

      const compiled = cortex.compileTurnPrompt({
        userMessage: currentEffectiveUserText,
        modelId: activeConfig?.modelId,
        stage,
        queryEmbedding,
        voiceIdentityMarkdown,
        screenContext: effectiveScreenContext,
        interruptionControlNote: input.interruptionControlNote,
        agencyToolsContext,
        conversationHistory: priorConversationHistory,
      })
      compiledSeriousness = compiled.seriousness
      userReaction = analyzeUserAffectReaction(currentEffectiveUserText, {
        seriousness: compiled.seriousness,
      })

      const effectiveOmniMode: OmniExecutionMode =
        input.omniExecutionModeOverride ?? activeConfig?.omniExecutionMode ?? 'modular'
      const omniPromptOverlay =
        effectiveOmniMode === 'native-omni'
          ? composeAshyTurnPrompt({
              userMessage: currentEffectiveUserText,
              seriousness: compiled.seriousness,
              omniOutputMode: 'native-audio',
            }).systemPrompt
          : ''
      const nativeDirectiveMatch = omniPromptOverlay.match(
        /\[NATIVE OMNI AUDIO OUTPUT DIRECTIVE\][\s\S]*?(?=\n\n\[|$)/,
      )
      const finalSystemPrompt =
        effectiveOmniMode === 'native-omni' &&
        nativeDirectiveMatch &&
        !compiled.systemPrompt.includes('[NATIVE OMNI AUDIO OUTPUT DIRECTIVE]')
          ? `${compiled.systemPrompt}\n\n${nativeDirectiveMatch[0]}`
          : compiled.systemPrompt

      const hasMultimodalInputs =
        Boolean(input.inputAudio) ||
        Boolean(input.videoFrames && input.videoFrames.length > 0) ||
        Boolean(input.attachments && input.attachments.length > 0)
      let userParts: ChatMessageContentPart[] | undefined
      if (hasMultimodalInputs) {
        userParts = []
        if (input.videoFrames && input.videoFrames.length > 0) {
          for (const vf of input.videoFrames) {
            userParts.push({
              type: 'video_frame',
              videoFrame: {
                dataUrl: vf.dataUrl,
                timestampMs: vf.timestampMs,
                ...(vf.width !== undefined ? { width: vf.width } : {}),
                ...(vf.height !== undefined ? { height: vf.height } : {}),
              },
            })
          }
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const att of input.attachments) {
            if (att.kind === 'image') {
              const url = att.dataUrlOrBase64.startsWith('data:')
                ? att.dataUrlOrBase64
                : `data:${att.mimeType};base64,${att.dataUrlOrBase64}`
              userParts.push({
                type: 'image_url',
                imageUrl: { url, detail: 'auto' },
              })
            } else if (att.kind === 'audio') {
              const lowerMime = att.mimeType.toLowerCase()
              const format: 'wav' | 'pcm16' | 'mp3' =
                lowerMime.includes('mp3') || lowerMime.includes('mpeg')
                  ? 'mp3'
                  : lowerMime.includes('pcm')
                    ? 'pcm16'
                    : 'wav'
              const cleanData = att.dataUrlOrBase64.replace(
                /^data:audio\/[a-z0-9.+-]+;base64,/i,
                '',
              )
              userParts.push({
                type: 'input_audio',
                inputAudio: {
                  data: cleanData,
                  format,
                },
              })
            }
          }
        }
        if (input.inputAudio) {
          const cleanData = input.inputAudio.dataBase64.replace(
            /^data:audio\/[a-z0-9.+-]+;base64,/i,
            '',
          )
          userParts.push({
            type: 'input_audio',
            inputAudio: {
              data: cleanData,
              format: input.inputAudio.format,
            },
          })
        }
        userParts.push({
          type: 'text',
          text: compiled.userTurnContent,
        })
      }

      const messages: ChatMessage[] = [
        ...priorConversationHistory,
        {
          role: 'user',
          content: compiled.userTurnContent,
          ...(userParts ? { parts: userParts } : {}),
        },
      ]

      const model = providerVault.createActiveLanguageModel()
      const ashyStageSignalTool: ToolDefinition | undefined =
        effectiveOmniMode === 'native-omni'
          ? defineTool({
              name: 'ashy_stage_signal',
              description:
                'Emite sinal de atuação Live2D (emoção, intensidade e motion) sem poluir o áudio falado.',
              parameters: v.object({
                emotion: v.picklist(ASHY_EMOTIONS),
                intensity: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
                motion: v.optional(v.string()),
                callbackMotifId: v.optional(v.string()),
              }),
              execute: async (args) => {
                const marker: TurnMarkerPayload = {
                  type: 'act',
                  emotion: args.emotion,
                  intensity: args.intensity ?? 0.8,
                  ...(args.motion ? { motion: args.motion } : {}),
                }
                markers.push(marker)
                turnEmotion = args.emotion
                currentDominantEmotion = args.emotion
                options.onDominantEmotionChange?.(args.emotion)
                try {
                  cortex.recordEmotionPulse(
                    args.emotion,
                    args.intensity ?? 0.8,
                    Date.now(),
                    { seriousness: compiledSeriousness },
                  )
                } catch {
                  // Fault-isolated
                }
                emit({
                  type: 'turn:marker',
                  turnId,
                  sessionId,
                  marker,
                })
                if (args.callbackMotifId && args.callbackMotifId.trim().length > 0) {
                  const motifId = args.callbackMotifId.trim()
                  const cbMarker: TurnMarkerPayload = {
                    type: 'callback',
                    motifId,
                  }
                  markers.push(cbMarker)
                  invokedMotifIds.push(motifId)
                  try {
                    cortex.recordJokeCallback(
                      motifId,
                      userReaction.positiveJokeReaction,
                      Date.now(),
                    )
                  } catch {
                    // Ignore unknown/hallucinated motifId
                  }
                  emit({
                    type: 'turn:marker',
                    turnId,
                    sessionId,
                    marker: cbMarker,
                  })
                }
                return { ok: true }
              },
            })
          : undefined
      const baseTools = options.agencyRuntime ? buildAgencyChatTools(options.agencyRuntime) : []
      const tools: ToolDefinition[] | undefined =
        baseTools.length > 0 || ashyStageSignalTool
          ? [...baseTools, ...(ashyStageSignalTool ? [ashyStageSignalTool] : [])]
          : undefined
      // Omni tools wired above
      void (true ? undefined
        : undefined
      )
      const stream = streamText(model, {
        system: finalSystemPrompt,
        messages,
        tools,
        maxSteps: 5,
        reasoningEffort: activeConfig?.reasoningEffort ?? 'none',
        ...(effectiveOmniMode === 'native-omni'
          ? {
              modalities: ['text', 'audio'] as const,
              audioOutput: {
                voice: activeConfig?.omniVoiceId ?? 'female',
                format: 'pcm16' as const,
              },
            }
          : {}),
        signal: controller.signal,
      })

      const reader = stream.getReader()
      const abortPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ done: true, value: undefined })
          return
        }
        controller.signal.addEventListener(
          'abort',
          () => resolve({ done: true, value: undefined }),
          { once: true },
        )
      })

      let lastActivityAt = Date.now()
      let sawTextDelta = false
      let audioChunkSeq = 0
      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), abortPromise])
          if (controller.signal.aborted || entry.abortedEmitted) {
            finalizeAbortEntry(entry)
            return
          }
          if (done) {
            break
          }
          if (!value) {
            continue
          }

          if (value.type === 'text-delta') {
            lastActivityAt = Date.now()
            sawTextDelta = true
            rawAccum += value.text
            parser.write(value.text)
          } else if (
            value.type === 'tool-call' ||
            value.type === 'tool-result' ||
            value.type === 'step-finish'
          ) {
            lastActivityAt = Date.now()
          } else if (value.type === 'input-transcript') {
            lastActivityAt = Date.now()
            const cleanTranscript = value.transcript.trim()
            if (cleanTranscript.length > 0) {
              currentEffectiveUserText = cleanTranscript
              compiledSeriousness = evaluateSeriousnessGate(cleanTranscript)
              userReaction = analyzeUserAffectReaction(cleanTranscript, {
                seriousness: compiledSeriousness,
              })
              try {
                cortex.appendChatMessage({
                  ...userMessage,
                  content: cleanTranscript,
                  rawContent: cleanTranscript,
                })
              } catch {
                // Fault-isolated
              }
              emit({
                type: 'turn:input-transcript',
                turnId,
                sessionId,
                userMessageId: userMessage.id,
                transcript: cleanTranscript,
                isFinal: value.isFinal ?? true,
                source: 'omni-native',
              })
            }
          } else if (value.type === 'audio-delta') {
            lastActivityAt = Date.now()
            if (!sawTextDelta && value.transcriptDelta) {
              rawAccum += value.transcriptDelta
              parser.write(value.transcriptDelta)
            }
            const cleanB64 = value.audioBase64.replace(/^data:audio\/[\w+-]+;base64,/, '')
            const rawBytes = Buffer.from(cleanB64, 'base64')
            let sampleRate = value.sampleRate > 0 ? value.sampleRate : 24000
            let samples: Float32Array
            if (
              value.format === 'wav' ||
              (rawBytes.byteLength >= 12 &&
                rawBytes[0] === 0x52 &&
                rawBytes[1] === 0x49 &&
                rawBytes[2] === 0x46 &&
                rawBytes[3] === 0x46)
            ) {
              try {
                const decoded = decodeWavToPcmBlocks(
                  rawBytes.buffer.slice(
                    rawBytes.byteOffset,
                    rawBytes.byteOffset + rawBytes.byteLength,
                  ),
                )
                samples = decoded.samples
                if (decoded.sampleRate > 0) {
                  sampleRate = decoded.sampleRate
                }
              } catch {
                samples = new Float32Array(0)
              }
            } else {
              const sampleCount = Math.floor(rawBytes.byteLength / 2)
              samples = new Float32Array(sampleCount)
              const view = new DataView(
                rawBytes.buffer,
                rawBytes.byteOffset,
                sampleCount * 2,
              )
              for (let i = 0; i < sampleCount; i++) {
                samples[i] = view.getInt16(i * 2, true) / 32768
              }
            }

            const samplesPerFrame = Math.max(1, Math.round(sampleRate * 0.02))
            const frameDurationSec = Number((samplesPerFrame / sampleRate).toFixed(4))
            const vowelFrames: VoiceSynthesizedVowelFrame[] = []
            let frameIdx = 0
            for (let offset = 0; offset < samples.length; offset += samplesPerFrame) {
              const slice = samples.subarray(
                offset,
                Math.min(samples.length, offset + samplesPerFrame),
              )
              const weights = extractPcmFrameVowelWeights(slice, sampleRate)
              const entries: Array<['A' | 'E' | 'I' | 'O' | 'U', number]> = [
                ['A', weights.A],
                ['E', weights.E],
                ['I', weights.I],
                ['O', weights.O],
                ['U', weights.U],
              ]
              entries.sort((a, b) => b[1] - a[1])
              const dominantVowel =
                weights.rmsVolume > 0.01 && entries[0]![1] > 0.02 ? entries[0]![0] : 'closed'
              vowelFrames.push({
                timeSec: Number((frameIdx * frameDurationSec).toFixed(4)),
                durationSec: frameDurationSec,
                A: weights.A,
                E: weights.E,
                I: weights.I,
                O: weights.O,
                U: weights.U,
                dominantVowel,
              })
              frameIdx += 1
            }
            const durationMs =
              samples.length > 0
                ? Math.max(1, Math.round((samples.length / sampleRate) * 1000))
                : 20

            const seq = audioChunkSeq
            audioChunkSeq += 1
            emit({
              type: 'turn:audio-delta',
              turnId,
              sessionId,
              seq,
              audioBase64: cleanB64,
              format: value.format === 'wav' ? 'wav' : 'pcm16',
              sampleRate,
              durationMs,
              vowelFrames,
              ...(value.transcriptDelta ? { transcriptDelta: value.transcriptDelta } : {}),
            })
          } else if (value.type === 'error') {
            if (controller.signal.aborted || entry.abortedEmitted) {
              finalizeAbortEntry(entry)
              return
            }
            throw new Error(value.error)
          }
        }
      } finally {
        void lastActivityAt
        try {
          reader.releaseLock()
        } catch {
          // Reader may still have a pending read if aborted mid-chunk; ignore lock release error
        }
      }

      if (controller.signal.aborted || entry.abortedEmitted) {
        finalizeAbortEntry(entry)
        return
      }

      parser.flush()

      const completedAt = Date.now()
      const latencyMs = Math.max(0, completedAt - startedAt)
      const rawClean = getCleanText().trim()
      const afterSlop = stripLeadingAssistantSlop(rawClean).trim()
      const afterBond = stripBondManipulation(afterSlop || rawClean).trim()
      const finalCleanContent = afterBond || afterSlop || rawClean || '...'

      const assistantMessage: ChatMessageRecord = {
        id: `msg-assistant-${turnId}`,
        sessionId,
        role: 'assistant',
        content: finalCleanContent,
        rawContent: rawAccum,
        emotion: turnEmotion,
        markersJson: JSON.stringify(markers),
        providerId: providerState.activeProviderId,
        modelId: activeConfig?.modelId ?? null,
        latencyMs,
        createdAt: completedAt,
      }

      // Stream is complete; mark turn no longer in-flight for this session before persisting assistantMessage
      activeTurnsById.delete(turnId)
      if (activeTurnsBySession.get(sessionId)?.turnId === turnId) {
        activeTurnsBySession.delete(sessionId)
      }

      // Post-turn SQLite persistence with strict fault isolation (companion-emergence invariant)
      let persistenceWarning: string | null = null
      try {
        cortex.appendChatMessage(assistantMessage)
        cortex.indexTurnMemory({
          turnId,
          userText: currentEffectiveUserText,
          assistantText: finalCleanContent,
          emotion: turnEmotion,
          now: completedAt,
        })
        cortex.reviewTurnMemories({
          retrievedMemories: compiled.retrievedMemories,
          assistantText: assistantMessage.content,
          invokedMotifIds,
          eligibleIntents: compiled.eligibleIntents,
          nowMs: completedAt,
        })
        await cortex.consolidateSessionMemories({
          sessionId: input.sessionId,
          nowMs: completedAt,
          force: false,
        })
        lastPersistenceWarning = null
        options.onPersistenceWarning?.(null)
      } catch (persistErr) {
        persistenceWarning =
          persistErr instanceof Error ? persistErr.message : String(persistErr)
        lastPersistenceWarning = persistenceWarning
        options.onPersistenceWarning?.(persistenceWarning)
      }

      let snapshot: AshyBootstrapSnapshot
      try {
        snapshot = await options.getBootstrapSnapshot()
      } catch (snapErr) {
        const snapWarn = snapErr instanceof Error ? snapErr.message : String(snapErr)
        if (!persistenceWarning) {
          persistenceWarning = snapWarn
          lastPersistenceWarning = persistenceWarning
          options.onPersistenceWarning?.(persistenceWarning)
        }
        const voiceRead = voiceStore.read()
        snapshot = {
          needsOnboarding: false,
          userProfile: { userName: null, userPronouns: null },
          relationship: {
            stage,
            familiarityScore: 0.1,
            trustScore: 0.1,
            totalTurns: 1,
            milestones: [],
          },
          affect: {
            mood: { ...ASHY_BASELINE_MOOD },
            traits: { ...ASHY_DEFAULT_TRAITS },
            dominantEmotion: currentDominantEmotion,
          },
          activeSession: {
            id: sessionId,
            title: 'Conversa',
            startedAt,
            updatedAt: completedAt,
            turnCount: 1,
            lastMessagePreview: assistantMessage.content.slice(0, 120),
          },
          sessions: [],
          messages: [userMessage, assistantMessage],
          memories: { facts: [], episodes: [], jokes: [] },
          voice: {
            content: voiceRead.content,
            diagnostics: voiceRead.diagnostics,
            updatedAt: voiceRead.updatedAt,
          },
          providers: providerState,
          runtimeDiagnostics: {
            dbMode: 'memory',
            dbPath: cortex.db.filePath,
            lastPersistenceWarning: persistenceWarning,
          },
        }
      }

      if (
        persistenceWarning !== null &&
        !snapshot.messages.some((m) => m.id === assistantMessage.id)
      ) {
        snapshot.messages = [...snapshot.messages, assistantMessage]
      }
      snapshot.runtimeDiagnostics.lastPersistenceWarning = persistenceWarning

      emit({
        type: 'turn:completed',
        turnId,
        sessionId,
        assistantMessage,
        snapshot,
        persistenceWarning,
      })
    } catch (err) {
      if (controller.signal.aborted || entry.abortedEmitted) {
        finalizeAbortEntry(entry)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      emit({
        type: 'turn:error',
        turnId,
        sessionId,
        code: 'LLM_REQUEST_FAILED',
        message,
        recoverable: true,
      })
    } finally {
      clearInterval(keepaliveTimer)
      activeTurnsById.delete(turnId)
      if (activeTurnsBySession.get(sessionId)?.turnId === turnId) {
        activeTurnsBySession.delete(sessionId)
      }
    }
  }

  function onEvent(listener: (event: AshyHostStreamEvent) => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    sendTurn,
    abortTurn,
    abortSessionTurn,
    abortAll,
    hasActiveTurnForSession: (sessionId: string) => activeTurnsBySession.has(sessionId),
    onEvent,
    getDominantEmotion: () => currentDominantEmotion,
    getLastPersistenceWarning: () => lastPersistenceWarning,
  }
}
