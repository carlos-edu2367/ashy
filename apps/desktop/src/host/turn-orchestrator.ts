import * as v from 'valibot'
import type { AshyCortex } from '@ashy/cortex'
import {
  createTailSafeMarkerParser,
  streamText,
  stripLeadingAssistantSlop,
  type ChatMessage,
} from '@ashy/llm'
import {
  SendTurnInputSchema,
  type AshyBootstrapSnapshot,
  type AshyEmotion,
  type AshyHostStreamEvent,
  type ChatMessageRecord,
  type SendTurnInput,
} from '@ashy/shared'
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
  getBootstrapSnapshot: () => AshyBootstrapSnapshot | Promise<AshyBootstrapSnapshot>
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
  onEvent(listener: (event: AshyHostStreamEvent) => void): () => void
  getDominantEmotion(): AshyEmotion
  getLastPersistenceWarning(): string | null
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
    const userMessage = cortex.appendChatMessage({
      id: `msg-user-${turnId}`,
      sessionId: input.sessionId,
      role: 'user',
      content: input.text,
      rawContent: input.text,
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
    appendCleanText: (chunk: string) => void
    getCleanText: () => string
  }): Promise<void> {
    const { entry, input, userMessage, providerState, appendCleanText, getCleanText } = params
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
    let fallbackSnapshot: AshyBootstrapSnapshot | null = null
    try {
      fallbackSnapshot = await options.getBootstrapSnapshot()
    } catch {
      fallbackSnapshot = null
    }

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
              cortex.recordEmotionPulse(signal.emotion, signal.intensity ?? 0.8, Date.now())
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
          try {
            cortex.recordJokeCallback(signal.motifId, true, Date.now())
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

      const compiled = cortex.compileTurnPrompt({
        userMessage: input.text,
        modelId: activeConfig?.modelId,
        voiceIdentityMarkdown,
        screenContext: input.screenContext,
        conversationHistory: priorConversationHistory,
      })

      const messages: ChatMessage[] = [
        ...priorConversationHistory,
        {
          role: 'user',
          content: compiled.userTurnContent,
        },
      ]

      const model = providerVault.createActiveLanguageModel()
      const stream = streamText(model, {
        system: compiled.systemPrompt,
        messages,
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
            rawAccum += value.text
            parser.write(value.text)
          } else if (value.type === 'error') {
            if (controller.signal.aborted || entry.abortedEmitted) {
              finalizeAbortEntry(entry)
              return
            }
            throw new Error(value.error)
          }
        }
      } finally {
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
      const finalCleanContent = stripLeadingAssistantSlop(rawClean).trim() || rawClean

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

      // Post-turn SQLite persistence with strict fault isolation (companion-emergence invariant)
      let persistenceWarning: string | null = null
      try {
        cortex.appendChatMessage(assistantMessage)
        cortex.indexTurnMemory({
          turnId,
          userText: input.text,
          assistantText: finalCleanContent,
          emotion: turnEmotion,
          now: completedAt,
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
        if (!fallbackSnapshot) {
          throw snapErr
        }
        snapshot = fallbackSnapshot
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
    onEvent,
    getDominantEmotion: () => currentDominantEmotion,
    getLastPersistenceWarning: () => lastPersistenceWarning,
  }
}
