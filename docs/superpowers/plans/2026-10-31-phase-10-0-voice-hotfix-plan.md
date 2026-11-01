# Phase 10.0 — Voice Hotfix (resposta idêntica + voz audível)

> **Origem:** `docs/superpowers/research/2026-10-31-live-mode-voice-research.md` (§1, §2, §7).
> **Decisões do usuário (2026-10-31):**
> - o usuário escolhe o backend (nada de modelo único);
> - Ollama e llama.cpp são providers separados;
> - voz de referência é enviada pelo usuário onde o backend suportar;
> - a 10.0 vem antes da spec grande.
>
> **Escopo:** só correções. O Live Call Engine (10.1+) **não** entra aqui.

## Spec curta

### Problemas (verificados ao vivo em 2026-10-31, Ollama 0.40.13)
| # | Problema | Evidência |
|---|---|---|
| P1 | A resposta é idêntica em todos os turnos. | GGUF com `top_k=1`. O Ollama `/v1/chat/completions` **ignora** `top_k`, tanto no topo quanto em `options`: o log mostra `top_k = 1`. O `/api/chat` nativo com `options.top_k=40` gera `top_k = 40` no log. |
| P2 | O histórico está envenenado. | `MAX_HISTORY_MESSAGES = 80`; placeholders `[Mensagem de voz Omni]` e respostas quase duplicadas são reenviados (`turn-orchestrator.ts:642-647`). |
| P3 | A voz nunca toca. | O `createGaplessAudioPlayer` não recebe `audioContext` (`useAshyStore.ts:1282`, `voice-session-runtime.ts:1209`). O `/tts` do llama-server filho do Ollama **funciona**: 200 `audio/wav`, ~4 s de áudio em 1,3 s, com `voice:"female"`. |
| P4 | STT e TTS falsos em produção. | `DEFAULT_VOICE_RUNTIME_SETTINGS` usa `deterministic-wav-stt` (frases fixas) e `local-synth-fallback` (tom de 185 Hz). O host mapeia `web-speech-tts` para o tom (`kernel.ts:2391`). |
| P5 | ASR alucina com clipes curtos ("Tchevin"). | Clipes com 10–18 tokens de áudio. |
| P6 | ASR usa um caminho frágil. | Port discovery por regex no `server.log`. O Ollama tem um endpoint oficial, `/v1/audio/transcriptions`, que **funciona** com `hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M` (testado). |

Também verificado: o Ollama `/v1/audio/speech` responde `"does not support speech"` para a tag `hf.co/...`. Por isso, a fala do LFM3 no Ollama continua pelo `/tts` do llama-server filho, até a 10.2 trazer o llama.cpp como provider próprio.

### Critérios de aceite
1. Com Ollama + LFM3, duas mensagens digitadas diferentes recebem respostas diferentes e pertinentes, mesmo com a sessão envenenada existente.
2. Com "Omni Nativo" e voz, a resposta é **ouvida** (pelo `/tts` ou pelo fallback de speechSynthesis), e o lip-sync se mexe.
3. Nenhum provider falso (`deterministic-wav-stt`, `local-synth-fallback`) é padrão nem aparece selecionável na UI de produção. Eles continuam disponíveis para testes e fixtures.
4. Clipes de voz com menos de 400 ms de áudio não são transcritos nem enviados.
5. `pnpm typecheck` e `pnpm test` passam.

## Tarefas (paralelizáveis; cada uma com arquivos próprios)

### T1 — Adapter nativo do Ollama (`/api/chat`) — `packages/llm`, `provider-vault.ts`
- Criar `createOllamaNativeModel(config)` em `packages/llm/src/ollama-native.ts`. Ele implementa a mesma interface `LanguageModel` e emite os mesmos eventos de stream que `createOpenAICompatibleModel` (`adapters.ts:343`). Pontos:
  - `POST {origin}/api/chat`, NDJSON streaming, `think:false` quando `reasoningEffort==='none'`, `keep_alive`.
  - `options: { temperature, top_k, top_p, repeat_penalty, num_ctx }`.
  - Defaults conversacionais: `temperature 0.7`, `top_k 40`, `top_p 0.9`, `repeat_penalty 1.1`.
  - Tools no formato Ollama (`tools`, `message.tool_calls` com `function.arguments` em **objeto**). Imagens em `images` (base64 sem prefixo).
  - `input_audio` (WAV base64) **também vai em `images`**: é o workaround documentado na issue ollama#19378.
  - `modalities` e `audioOutput` são ignorados.
  - Abort via `signal`; erros HTTP com corpo legível.
- Derivar o origin do baseUrl: `http://127.0.0.1:11434/v1` → `http://127.0.0.1:11434`.
- `provider-vault.ts`: `createLanguageModel()` usa o adapter nativo quando `activeProviderId === 'ollama'`. Os demais providers ficam como estão.
- Testes em `packages/llm/test/`: fetch mockado, cobrindo NDJSON de texto, tool call, abort, mapeamento de `options` e o roteamento no vault.
- Verificação real (opcional, se o Ollama estiver rodando): duas mensagens diferentes geram respostas diferentes, e o `server.log` mostra `top_k = 40`.

### T2 — Histórico, ASR e TTS no host — `turn-orchestrator.ts`, `ollama-native-audio-bridge.ts`, novo `host/conversation-history.ts`
- `sanitizeConversationHistory(records, { maxMessages, maxChars })`, uma função pura:
  - remove mensagens de usuário com placeholder (`[Mensagem de voz Omni]` e variantes vazias), junto com a resposta do assistente imediatamente seguinte quando ela respondia ao placeholder;
  - colapsa respostas do assistente quase duplicadas (texto normalizado com similaridade ≥ 0.85; fica só a mais recente);
  - preserva a alternância de papéis;
  - aplica um limite por provider: Ollama/local fica com as **últimas 8 mensagens e ~6000 chars**; os outros mantêm 80.
- Aplicar em `turn-orchestrator.ts:642`.
- **Parar de persistir** o placeholder como conteúdo visível. Quando não houver transcrição, salvar `content` = `"🎤 (áudio)"` com uma flag ou metadata que o sanitizador também exclua. Se a mudança de schema for invasiva, manter o texto atual e confiar no filtro.
- Guarda de ASR: WAV com menos de 400 ms de PCM (ou RMS abaixo do limiar) → não transcreve e o turno é descartado com o evento `turn:error`/aviso já existente mais adequado.
- `transcribeNativeOllamaOmniAudio`:
  1. tentar primeiro o endpoint oficial `POST {ollamaOrigin}/v1/audio/transcriptions` (multipart: `model`, `language=pt`, `file`);
  2. só se falhar, cair no caminho do llama-server atual.

  Rejeitar transcrições que pareçam resposta de chat: começam com "A única palavra", "O áudio", "Não há" etc. Fazer uma heurística simples e documentada.
- `synthesizeNativeOllamaOmniSpeech`: normalizar `voice` para `'female' | 'male'`; ids desconhecidos viram `'female'`.
- Testes unitários do sanitizador (com o caso real: três respostas iguais mais placeholders), da guarda de duração e da normalização de voz.

### T3 — Playback audível no renderer — `useAshyStore.ts`, `packages/voice/src/voice-session-runtime.ts`
- Criar um `AudioContext` único, de forma preguiçosa, num gesto do usuário (`toggleVoiceConversation`, envio de mensagem) e chamar `resume()`.
- Entregar esse contexto ao `GaplessAudioPlayer` do voice runtime, por exemplo com `voiceRuntime.attachAudioContext(ctx)` ou pela recriação controlada do player. Hoje ele roda só com o relógio virtual.
- Garantir que `turn:audio-delta` (WAV de 24 kHz do `/tts`) seja decodificado e **tocado**.
- O fim do "speaking" passa a ser o fim real da fila do player (`onPlaybackEnded`), e não o timer estimado, quando houver áudio real.
- Lip-sync: os vowel frames do player alimentam `simulatedVowels`/`rawVolume` durante a reprodução, já existe `onVowelFrame`. Fechar a boca no fim real.
- `triggerBargeIn` para o player (fade) além do `speechSynthesis.cancel()`.
- Se chegar áudio omni mas ele não tocar (contexto ausente ou erro de decode), não pular o fallback: enfileirar o texto no TTS do navegador.
- Testes com AudioContext fake (`createBuffer`/`createBufferSource`), verificando que `start()` é chamado e que o barge-in para.

### T4 — Defaults reais de STT/TTS — `packages/shared/src/host-protocol.ts`, `kernel.ts`, `App.tsx` (só o select de providers de voz)
- Novo STT `ollama-transcriptions`: o host faz `POST {ollamaOrigin}/v1/audio/transcriptions` com o modelo ativo do Ollama, ou com `sttModelId` se configurado.
  - Ele passa a ser o **padrão** quando o provider ativo for o Ollama.
  - Caso contrário, o padrão é `local-whisper-http`.
  - Adicionar ao schema e à UI.
- TTS padrão: `web-speech-tts`.
- O host **não** mapeia mais `web-speech-tts` para o tom. Ele responde com o erro/código `use-browser-tts`, e o renderer usa `speechSynthesis`.
  - Conferir que `useAshyStore.ts:1762-1812` já trata isso. Se for preciso mexer no store, coordenar com T3 apenas nesse ponto e preferir ajustar só o host.
- `deterministic-wav-stt` e `local-synth-fallback` saem das opções da UI e dos defaults. Continuam registrados para testes e fixtures.
  - Migração ao carregar settings salvos: ids falsos viram os novos defaults.
- `wakeWordEnabled` padrão `false`. Em modo contínuo, o wake word travava a conversa após cada turno. Settings já salvos explicitamente pelo usuário são respeitados.
- Atualizar os testes que fixam os defaults antigos. Fixtures de cenário podem continuar forçando os providers falsos de forma explícita.

## Integração (orquestrador)
1. Rodar `pnpm typecheck` e `pnpm test` completos e corrigir conflitos entre as tarefas.
2. Verificação real contra o Ollama local: script de probe com o formato de request do app (adapter nativo + histórico sanitizado) usando a cópia do DB envenenado.
3. Commit(s) convencionais em `main`.
4. Instruir: `git pull` + `install.ps1` em `C:\Users\carlos\Documents\agents\ashy`.
