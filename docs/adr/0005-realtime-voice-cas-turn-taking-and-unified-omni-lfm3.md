# ADR-0005: Voz em Tempo Real com Turn-Taking CAS, Barge-In com `PlaybackReceipt` e Arquitetura Multimodal Omni Unificada (`LFM3-Omni-2B`)

- **Status:** Accepted
- **Date:** 2026-10-31
- **Milestone:** Fase 5, Fase 8.6 & Fase 8.7 (M4.7 — Omni Unificado)

---

## Context

Conversas de voz com assistentes tradicionais sofrem de três problemas estruturais:
1. **Corte prematuro de pausas humanas:** Timers simples de silêncio (ex.: `500ms`) cortam o usuário quando ele apenas respira ou pensa no meio de uma frase, ou disparam respostas duplicadas por *race conditions* quando o usuário volta a falar enquanto o STT/LLM está decidindo.
2. **Cegueira de interrupção (*Barge-In*):** Quando o usuário interrompe a assistente no meio de um parágrafo longo, o histórico do LLM continua achando que o parágrafo inteiro foi ouvido pelo usuário.
3. **Latência acumulada em cascatas modulares (`STT -> LLM -> TTS`):** Embora pipelines modulares ofereçam flexibilidade para misturar provedores (Whisper + Claude + ElevenLabs/Kokoro), usuários com hardware local moderno também desejam rodar **1 único modelo multimodal local** (`LFM3-Omni-2B`) que ouça o áudio diretamente em 16kHz, enxergue vídeo a `2 fps` e responda com áudio nativo em 24kHz (`LiquidCodec`) sem estágios intermediários.

## Decision

1. **Ring Buffer com `HistoryLease` (`360ms`) e Turn-Taking com *Compare-And-Swap* (CAS):**
   - O `AudioWorklet` alimenta um Ring Buffer contínuo que preserva **`360ms` de pré-rolagem (`HistoryLease`)**, garantindo que a consoante inicial da fala do usuário nunca seja cortada antes do disparo do Silero VAD ONNX.
   - O `VoiceTurnController` implementa máquina de estados protegida por tokens **Compare-And-Swap (`turnEpoch`)**:
     - Aos `600ms` de silêncio, prepara `SpeculativeRephrase`;
     - Aos `1200ms` de silêncio, aciona o `VoiceEndJudge` para decidir se o pensamento terminou (`COMPLETE`) ou se merece até `3000ms` de *grace period* (`WAIT_MORE`);
     - Se o usuário retomar a fala antes do selamento, o epoch incrementa atomicamente e invalida qualquer julgamento assíncrono em voo.

2. **Barge-In em 2 Fases com `PlaybackReceipt` Exato (`heardText` / `unheardText`):**
   - Quando o usuário fala por cima da Ashy, o player executa um fade-out suave de `120ms` e calcula, a partir do relógio real do `AudioContext`, o `PlaybackReceipt` contendo exatamente o trecho ouvido (`heardText`) e o trecho não ouvido (`unheardText`), injetando `[Interrupted after Xs — user only heard: "..."]` no próximo turno.

3. **Arquitetura Multimodal Tri-Modo (`native-omni`, `hybrid-omni-in`, `modular`) com Foco Local no `LFM3-Omni-2B`:**
   - Em `@ashy/llm`, `@ashy/voice` e `TurnOrchestrator`, unificamos o suporte a três modos de execução:
     - **`native-omni`:** Envia o buffer WAV 16kHz do turno (`directOmniAudio`) + quadros de vídeo a `2 fps` deduplicados por `dHash` (`omni-media-sampler.ts`) diretamente ao modelo (`lfm3-omni:2b` no Ollama / `LiquidAI/LFM3-Omni-2B-GGUF` no `llama-server` com `reasoningEffort: 'none'` / `think: false`, ou `gpt-4o-audio-preview` / `qwen2.5-omni-7b`), transmitindo chunks `turn:audio-delta` (`24kHz PCM16`/`LiquidCodec`) direto para o `GaplessAudioPlayer` e lip-sync formante.
     - **`hybrid-omni-in` (e Auto-Downgrade em HTTP 400):** Envia áudio 16kHz + vídeo `2 fps` diretamente ao modelo multimodal (ex.: `google/gemini-2.5-flash` ou endpoints Omni sem decoder de áudio de saída) e sintetiza a resposta textual via TTS.
     - **`modular`:** Combina provedores dedicados de STT (`faster-whisper-server`, `whisper.cpp`, Groq `whisper-large-v3-turbo`, OpenAI `gpt-4o-mini-transcribe`, Web Speech) e TTS (`Kokoro-FastAPI`, `Piper HTTP`, `ElevenLabs`, `OpenAI TTS`, Web Speech) usando `MarkdownSegmenter`, *TTFA Boost Chunker* (`4..12` palavras nos 2 primeiros chunks) e fila paralela 4x reordenada.

## Consequences

### Positivas
- **Conversa natural sem atropelos:** Pausas de reflexão não cortam o usuário, e interrupções (*barge-in*) preservam a verdade do que realmente foi ouvido.
- **Execução 100% local em 1 único modelo (`LFM3-Omni-2B`):** Reduz drasticamente o consumo de VRAM/RAM e o TTFA ao eliminar processos separados de STT, VLM e TTS quando em modo `native-omni`.
- **Resiliência por Auto-Downgrade:** Se um servidor Omni retornar apenas texto ou HTTP 400 para modalidade de saída de áudio, o turno completa sem erro via `hybrid-omni-in`.

### Negativas / Trade-offs
- Manter os três modos (`native-omni`, `hybrid-omni-in`, `modular`) exige sincronização cuidadosa do `PlaybackReceipt` tanto para chunks de sentença TTS quanto para streams contínuos `turn:audio-delta` (`computeOmniPlaybackReceipt`).

## Codebase References
- `packages/voice/src/ring-buffer.ts`
- `packages/voice/src/turn-policy.ts`
- `packages/voice/src/turn-intelligence.ts`
- `packages/voice/src/vad-engine.ts`
- `packages/voice/src/chunker.ts`
- `packages/voice/src/tts-pipeline.ts`
- `packages/voice/src/barge-in.ts`
- `packages/voice/src/omni-voice-bridge.ts`
- `packages/voice/src/voice-session-runtime.ts`
- `packages/llm/src/adapters.ts`
- `apps/desktop/src/services/omni-media-sampler.ts`
- `apps/desktop/src/main/turn-orchestrator.ts`
