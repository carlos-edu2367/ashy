# Phase 10: Live Call Engine (Live Mode)

- **Data:** 2026-10-31
- **Status:** Aprovado pelo Carlos (2026-10-31)
- **Autores:** Claude & Carlos
- **Base:** commit `d8b66f7`, depois da hotfix 10.0
- **Insumos:**
  - `docs/superpowers/research/2026-10-31-live-mode-voice-research.md` (diagnóstico, pesquisa externa, padrões de referência)
  - `docs/superpowers/plans/2026-10-31-phase-10-0-voice-hotfix-plan.md` (hotfix já entregue)
  - mapeamento de pontos de integração (seção 13)

---

## 1. Objetivo

Fazer do **Live Mode** o modo principal da Ashy: uma **chamada de voz contínua e mãos-livres**. O usuário fala, ela responde **com voz**, com baixa latência. Pode ser interrompida naturalmente, o avatar faz lip-sync e expressa emoção, e ela continua sendo a Ashy (memória, persona, história compartilhada). Isso vale para qualquer backend que o usuário escolher.

A métrica de sucesso é o `ASHY_PROJECT_CONTEXT.md` §7: *"a experiência deve parecer uma conversa contínua, não uma sequência lenta de gravações de áudio"*.

## 2. Decisões de produto (brainstorming de 2026-10-31)

| # | Decisão |
|---|---|
| D1 | **O usuário escolhe** o backend e o modelo do Live Mode. Não há modelo único imposto. |
| D2 | **Ollama e llama.cpp (`llama-server`) são providers separados**, lado a lado. |
| D3 | **Voz de referência:** nos backends que aceitam, o usuário envia o próprio áudio de referência. Nos que não aceitam, aparece um seletor de vozes do provedor. A UI é guiada por capability. |
| D4 | **Ordem de entrega:** primeiro **local omni** (LFM3-Omni via llama.cpp `/v1/realtime`), depois nuvem (Gemini Live, OpenAI Realtime), depois cascata local. Tudo fica nesta spec. |
| D5 | **Entrada:** um botão **Ligar/Desligar** abre uma chamada contínua com VAD. Push-to-talk fica como opção nas configurações. |
| D6 | **Motores locais:** a **Ashy baixa e gerencia** em um clique: detecta a GPU, baixa o binário e os modelos, sobe e derruba o processo. Também é possível apontar a URL de um servidor próprio. |
| D7 | **Transcrição:** as falas dos dois lados entram no **chat e na memória como mensagens normais**, marcadas como voz. A fala da Ashy é **cortada no ponto em que foi interrompida**. |
| D8 | **Ferramentas na chamada:** sim. Ações sensíveis pedem aprovação (por voz ou na tela). Ficam desligadas automaticamente quando o backend não suporta tools. |
| D9 | **Visão na chamada:** sim, quando o backend suporta imagem. No local omni a tela é descrita por um passo de visão separado e entra como texto. |
| D10 | **Iniciativa:** em silêncio prolongado ela pode puxar assunto, **raramente e com contexto**. Usa o motor de iniciativa existente e é configurável. |
| D11 | **Overlay:** o avatar flutuante ganha controles mínimos de chamada (ligar/desligar, mute, indicador de estado). A chamada funciona com a janela principal fechada. |
| D12 | Privacidade: **nada sai da máquina** além do que o usuário configurar explicitamente, ou seja, os provedores de nuvem que ele escolher. |

## 3. Fora de escopo

- Full-duplex verdadeiro (ela falar e ouvir ao mesmo tempo como o Moshi). Nenhum modelo com pt-BR suporta isso hoje. O modo é half-duplex com barge-in.
- Treinar ou fazer fine-tune de voz. "Voz de referência" significa clonagem zero-shot do backend.
- Wake word durante a chamada. A chamada já é o estado de escuta; o wake word continua servindo só fora dela.
- Avatar 3D/XR.

## 4. Fatos técnicos que restringem o design (verificados em 2026-10-31)

### llama.cpp `b12024`, `llama-server` `/v1/realtime`
- Tem binários Windows CUDA 12.4/13.4, Vulkan e CPU. A máquina do Carlos tem uma RTX 4060 de 8 GB.
- Áudio de entrada é PCM16 mono na taxa do modelo (`session.created.audio.input.format.rate`). Áudio de saída é PCM16 de 24 kHz.
- `instructions` e `tools` **só podem ser definidos antes do primeiro áudio ou mensagem**.
- **Não tem VAD no servidor, não tem `truncate` e não tem `input_audio_buffer.clear`.** O cliente faz `commit` e `response.create`.
- `["audio"]` sozinho sai embolado (issue #31436). **Use `["text","audio"]`** (intercalado).
- Os eventos `conversation.item.create` aceitam só `input_text` e `function_call_output`. **Não aceitam imagem.**
- `POST /tts` aceita `speaker_ref_b64` ou upload multipart `speaker_ref`, e `voice` `female`/`male`. A documentação recomenda fortemente usar referência.
- `/v1/chat/completions` no mesmo servidor aceita imagem e áudio de entrada (via mmproj).

### LFM3-Omni-2B
- Arquivos: `LFM3-Omni-2B-Q4_K_M.gguf` (1,10 GB) e `mmproj-LFM3-Omni-2B-Q8_0.gguf` (507 MB). Para fala, recomenda-se o mmproj Q8_0.
- Rodar com `--reasoning off`.
- Fala: temperatura de áudio 0,4 e penalidade de repetição 1,2.
- Português aparece na lista de saída de fala; o sotaque precisa ser validado.
- Tool-calling é fraco.

### Gemini Live
- WSS com token efêmero. Entrada PCM16 de 16 kHz, saída de 24 kHz.
- Tem VAD no servidor e a flag `interrupted`. **Não tem truncate.**
- Sessão só de áudio dura 15 min. Para durar mais: resumption e compression.
- pt-BR explícito.

### OpenAI Realtime
- WebRTC ou WS, 24 kHz, `server_vad`/`semantic_vad`.
- **Tem `conversation.item.truncate`.**
- `instructions` mutáveis.
- Token efêmero via `client_secrets`.

### Spike real (2026-10-31): `llama-server` 0.8.0-dev embutido no Ollama 0.40.13, RTX 4060, LFM3-Omni Q4_K_M

Script em `scratchpad\spike-realtime.mjs`. A pergunta foi gerada pelo `/tts`, enviada em chunks de 50 ms, seguida de `commit` + `response.create`.

| Entrada | Instructions | Resultado | 1º áudio |
|---|---|---|---|
| **Áudio** pt-BR | `Respond in interleaved text and audio.` (frase do model card) | Responde de verdade, **mas em inglês** | ~350 ms |
| **Áudio** pt-BR | Persona em PT (ou EN pedindo PT) + frase de modo | **Repete a pergunta** em vez de responder; às vezes áudio sem sentido (até 80 s) | ~300–400 ms |
| **Áudio** pt-BR | Persona com `Perform TTS…` | Eco (é o prompt de "ler em voz alta"); **nunca usar** | — |
| **Texto** pt-BR (`input_text`) | Só a frase de modo | Texto ok, mas **o áudio disparou: 322 s de fala degenerada** | 101 ms |
| **Texto** pt-BR (`input_text`) | **Persona em inglês + "Always respond in Brazilian Portuguese" + frase de modo** | ✅ "Oi, tudo bem? Gatos são ótimos parceiros…": coerente, áudio confere com o texto | **115 ms** |

ASR do mesmo áudio por `ollama /v1/audio/transcriptions`: **~280 ms** (4 s de fala), com texto correto.

**Conclusões que mudam o design:**
1. **O modo padrão do LFM3 local é "transcreve → realtime com texto → fala"** (§8.1). O usuário fala; o engine faz VAD e transcreve (~280 ms); o texto entra como `input_text` na sessão realtime; a resposta sai em texto e áudio intercalados. Latência estimada do fim da fala até o primeiro áudio: endpoint (~700 ms) + ASR (~280 ms) + ~115 ms ≈ **1,1 s**. Bônus: a transcrição do usuário vem de graça (D7, memória, aprovação por voz).
2. **"Áudio direto" (entrada de áudio na sessão) fica como opção experimental.** Em pt-BR, com este build e este mmproj, ele não funciona. Precisa ser revalidado com o llama.cpp `b12024` upstream e o mmproj Q8_0 (primeiro passo da 10.1).
3. **As instructions seguem o formato do model card:** persona curta **em inglês** + `Always respond in Brazilian Portuguese` + **a última linha `Respond in interleaved text and audio.`** As memórias e o contexto da Ashy vão em `input_text` (`[Contexto] …`), não nas instructions.
4. **Limitador de fala descontrolada é obrigatório:** `max_output_tokens` por resposta, um watchdog que dispara `response.cancel` quando a duração do áudio passa de ~3× o estimado pelo texto ou de 45 s, e um detector de repetição ou vogal sustentada no texto.
5. Amostra boa: `scratchpad\spike-good-answer-ptbr.wav`. Amostra só de TTS: `scratchpad\tts-female-sample.wav`.

### Ashy hoje (ver §13)
- As janelas hub e overlay têm **stores separadas**, e as duas reagem aos mesmos eventos.
- O transporte host↔renderer é JSON (RPC + eventos duplicados por IPC e SSE). Não carrega áudio binário.
- O "Eyes" de tela é sintético.
- Cards de aprovação não têm evento push.
- `chat_messages` não tem colunas de modalidade nem de interrupção.

---

## 5. Arquitetura

```
┌──────────── Electron main (host/kernel) ────────────┐
│ EngineManager (Ollama | LlamaCpp)  — instala/sobe/saúde │
│ LiveModeSettings + VoiceReferenceStore                  │
│ LiveSessionContextBuilder (persona+memória por backend)  │
│ CallToolRouter (gatekeeper existente)                    │
│ VisionDescriber (frame → texto, p/ backends sem imagem)  │
│ CallRecorder (appendVoiceTurn → cortex + memória)        │
│ CloudTokenMinter (Gemini/OpenAI efêmeros)                │
│ CallStateHub  ── broadcast `call:state`, `call:viseme` ──┼──► hub + overlay (views)
└──────────────────────────▲──────────────────────────────┘
                           │ RPC de controle (`call:*`)
┌──────── Janela oculta "call-engine" (renderer dono) ────┐
│ Capture (worklet 16k) → Silero VAD → TurnDetector        │
│ CallEngine (máquina de estados, ledger, barge-in)        │
│ VoiceSession adapter ⇄ backend (WS direto)               │
│ Playback (AudioContext único, gapless, recibos, lip-sync)│
└──────────────────────────────────────────────────────────┘
```

### 5.1 Dono único da chamada: janela oculta `call-engine`

Microfone, VAD, sessão do backend e playback ficam numa **BrowserWindow oculta dedicada**, criada no primeiro `call:start`. Ela usa `show:false`, `backgroundThrottling:false`, a mesma preload e `?view=call-engine`. Motivos:
- **AEC.** O cancelamento de eco do Chromium funciona melhor com captura e reprodução no mesmo renderer.
- **Independência.** A chamada sobrevive ao fechamento do hub (D11), e o overlay continua leve.
- **Fim da dupla reação.** Hub e overlay viram só views do `CallState` que o host transmite.
- **Outros papéis.** A janela call-engine não renderiza UI. O overlay recebe `call:viseme` (~30 Hz) para o lip-sync. O hub mostra o estado, as legendas e as mensagens.
- **Mais tarde:** se a validação mostrar que dá para tirar a dependência do DOM, a janela pode virar um `utilityProcess`. Isso não é necessário agora.

### 5.2 Transporte de áudio

| Backend | Como o renderer fala com o backend | Segredo |
|---|---|---|
| llama.cpp local | WebSocket **direto** `ws://127.0.0.1:<port>/v1/realtime?model=…` (a CSP já permite) | nenhum |
| Gemini Live / OpenAI Realtime | WSS **direto**, com token efêmero gerado no main via RPC `call:mintToken` | a chave real fica no main |
| Cascata | STT, LLM e TTS via RPCs do host (a cascata já existe no host) | main |

O áudio da chamada **nunca** passa por `turn:audio-delta` nem pelo transporte JSON do host.

**CSP:** adicionar `wss://generativelanguage.googleapis.com` e `wss://api.openai.com`. Só entram nas builds e só são usados quando o usuário configura esses backends.

### 5.3 Interface única `VoiceSession` (inspirada no LiveKit `RealtimeModel`)

```ts
interface VoiceSessionCapabilities {
  serverTurnDetection: boolean     // Gemini/OpenAI true; llama.cpp false
  messageTruncation: boolean       // OpenAI true
  mutableInstructions: boolean     // OpenAI true; llama.cpp false; Gemini false
  contextInjection: 'instructions' | 'input_text_item' | 'client_content'
  userTranscription: boolean       // Gemini/OpenAI true (input transcription); llama.cpp false*
  toolCalls: boolean
  imageInput: boolean              // Gemini/OpenAI true; llama.cpp false (→ VisionDescriber)
  speakerReference: boolean        // só no modo híbrido llama.cpp (+ /tts) e cascata com TTS clonável
  voices: string[]                 // vozes fixas do provedor (seletor)
  inputSampleRate: number
  outputSampleRate: number
}
interface VoiceSession {
  readonly caps: VoiceSessionCapabilities
  connect(init: SessionInit): Promise<void>   // instructions, tools, voice, history seed
  pushAudio(pcm: Int16Array): void
  commitUserTurn(): void                       // quando o turno é detectado no cliente
  respond(opts?: { contextText?: string }): void
  cancelResponse(): void
  truncate?(itemId: string, playedMs: number): Promise<void>
  injectContext(text: string): Promise<void>   // via o mecanismo de caps.contextInjection
  sendToolResult(callId: string, output: string): void
  sendImage?(jpegBase64: string): void
  close(): Promise<void>
  on(event: VoiceSessionEvent, cb): void
}
type VoiceSessionEvent =
  | 'user_speech_started' | 'user_speech_stopped' | 'user_transcript'
  | 'response_started' | 'response_audio' | 'response_text' | 'response_done'
  | 'tool_call' | 'error' | 'closed'
```

\* No llama.cpp, a transcrição do usuário vem de um passo à parte (§6.4).

**Implementações:**
- `LlamaCppRealtimeSession` (10.1)
- `LlamaCppHybridSession`: realtime com `["text"]` + `/tts` com `speaker_ref` (10.2)
- `GeminiLiveSession`, `OpenAIRealtimeSession` (10.4)
- `CascadeSession`: STT → qualquer LLM do vault → chunker → TTS (10.5)

**Regra:** o motor (`CallEngine`) não conhece nenhum backend, só lê `caps`.

---

## 6. CallEngine

### 6.1 Máquina de estados

```
idle ─start→ connecting ─ok→ listening
listening ─VAD onset confirmado (≥ minSpeechMs)→ user_speaking
user_speaking ─fim de turno (silêncio ≥ endpointMs [+ smart-turn opcional])→ thinking
user_speaking ─silêncio curto, turno incompleto→ listening (grace)
thinking ─primeiro áudio tocado→ speaking
thinking ─usuário volta a falar→ user_speaking (cancelResponse; nada tocado = nada salvo)
speaking ─VAD onset→ interrupt_pending (ducking −12 dB, não descarta)
interrupt_pending ─fala confirmada (≥ bargeInMinMs, ou transcrição com ≥ 2 palavras)→ interrupted
interrupt_pending ─nada em falseInterruptionMs→ speaking (restaura o volume)
interrupted ─fade 120 ms + recibo→ commit truncado → user_speaking
speaking ─fila de áudio esgotada→ listening
* ─erro de backend→ reconnecting (até N tentativas) → listening | ended(motivo)
* ─stop→ ended → idle
```

- **AEC warm-up:** durante os primeiros `aecWarmupMs` (padrão 1500 ms) de cada fala da Ashy, o barge-in exige confiança maior.
- **Backchannel:** "aham" e "uhum" com menos de `bargeInMinMs` não interrompem.
- **Mute:** a captura continua (para manter o medidor), mas nada é enviado nem detectado.
- **Motivos de término tipados:** `user_hangup | mic_denied | mic_lost | backend_unavailable | backend_error | session_expired | engine_not_installed`.

### 6.2 Detecção de turno no cliente

Vale quando `!caps.serverTurnDetection`, ou quando o usuário preferir VAD local.
- **Silero VAD v5** via `onnxruntime-web` (WASM), num Worker. O asset do modelo vai empacotado.
- `createSileroOnnxVadEngine` já existe; só falta o `sessionLoader`. O VAD DSP híbrido continua como fallback.
- **Padrões:** limiar 0,5 (com histerese), `minSpeechMs` 250, `endpointMs` 700, `preRollMs` 360, `graceMs` 1500.
- **Smart-Turn v3** (ONNX, 8 MB): opcional na 10.2. Desligado por padrão até validar a precisão em PT.
- **Backends com VAD no servidor:** o VAD local continua rodando, mas só para o ducking imediato e para o estado da UI.

### 6.3 Ledger de conversa e histórico fiel

Cada resposta recebe um `itemId`. Cada chunk de áudio carrega `{itemId, seq, textSpan?}`.

O `GaplessAudioPlayer` (já existe) devolve `playedMs`. O `PlaybackReceipt` (já existe) mapeia `playedMs` para o texto falado:
- quando há timestamps, usa o texto intercalado em `["text","audio"]`;
- senão, usa uma proporção pela duração.

Ao final de cada troca, o engine chama `call:recordTurn` (§7.4) com `{userTranscript, assistantSpokenText, interrupted, playedMs, backendId, markers}`.

**Propagação ao backend em uma interrupção:**
- **OpenAI:** `truncate(itemId, playedMs)`.
- **llama.cpp e Gemini:** antes do próximo `respond`, injeta uma nota de sistema via `injectContext`: `"[Sua fala anterior foi interrompida após: «…»]"`.
- **Último recurso:** se o contexto do backend divergir demais (por exemplo, 3 interrupções seguidas), a sessão é rotacionada e semeada a partir do ledger.

**Nunca persistir** texto não tocado nem placeholders.

### 6.4 Transcrição do usuário em backends sem `userTranscription` (llama.cpp)

Assim que o turno é commitado, o engine envia o mesmo áudio (WAV de 16 kHz, já bufferizado) para a transcrição. Isso roda **em paralelo** com a resposta e não atrapalha a latência. A ordem de preferência:
1. `/v1/chat/completions` do próprio llama-server, com `input_audio` e o prompt `asr` (o mesmo modelo, que já está em memória);
2. o STT configurado da cascata.

O texto serve para:
- o chat (D7);
- a memória e a busca de memórias do turno seguinte;
- a aprovação por voz (§8.2).

Se a transcrição falhar, a mensagem é salva como `🎤 (fala não transcrita)` com `modality='voice'` e **nunca** entra no histórico enviado ao LLM.

### 6.5 Playback, lip-sync e emoção

- **Playback:** um `AudioContext` na janela call-engine, com o `GaplessAudioPlayer` da 10.0 (`attachAudioContext`, fades, recibos).
- **Lip-sync:** `analyzePcmFrameToVowels` (`packages/stage/src/drivers/acoustic-lip-sync.ts`) roda sobre cada chunk tocado, e o ticker de 33 ms gera vowel frames. O host transmite isso como `call:viseme {A,E,I,O,U,volume}`, com throttle de 30 Hz, para o hub e o overlay.
- **Emoção, por camadas:**
  1. Se o texto intercalado trouxer `<|ACT …|>`, o marker é parseado e removido da legenda.
  2. Se o backend tiver tools confiáveis (nuvem), entra a tool `ashy_stage_signal`, que é não-bloqueante e recebe resposta `ok` imediata.
  3. Fallback: o `call:classifyAffect` do host roda o categorizador ou o motor afetivo existente sobre o texto de cada segmento. É barato e não depende do modelo.

  Em todos os casos, o sinal é preso ao segmento e aplicado quando aquele segmento começa a tocar.

### 6.6 Métricas de latência

Medidas por turno:

| Métrica | Intervalo |
|---|---|
| `endpointMs` | fim da fala → commit |
| `ttfbMs` | commit → primeiro delta de áudio |
| `playbackStartMs` | primeiro delta → primeiro sample tocado |
| `e2eMs` | fim da fala → primeiro sample tocado |

São expostas em `call:state.metrics` e na tela de teste (§9).

**Alvos no llama.cpp local (RTX 4060):** `e2e` p50 ≤ 900 ms e p90 ≤ 1500 ms. São metas de validação, não bloqueiam o merge.

---

## 7. Host

### 7.1 `EngineManager`: Ollama e llama.cpp lado a lado (D2, D6)

Generalizar o `LocalRuntimeManager` para a interface `LocalEngine { id, detect, install(onProgress), start, stop, health, listModels, downloadModel(spec, onProgress), deleteModel }`.
- **`OllamaEngine`:** o comportamento atual, que já existe.
- **`LlamaCppEngine`** (novo):
  - **GPU:** detectada via `nvidia-smi` (e driver). Se houver NVIDIA, usa `cuda-12.4` mais o zip `cudart`. Senão, tenta Vulkan se disponível; por último, CPU. O usuário pode trocar a variante.
  - **Binário:** `https://github.com/ggml-org/llama.cpp/releases/download/<build>/llama-<build>-bin-win-<variant>-x64.zip`, com o **build fixado** (`b12024`) e SHA256 registrado no código. Vai para `userData\engines\llama.cpp\<build>-<variant>\`.
  - **Downloads:** em streaming, com progresso, retomada (`Range`) e verificação de tamanho/SHA.
  - **Modelos:** um catálogo `LIVE_LOCAL_MODELS`. No começo, LFM3-Omni-2B (Q4_K_M + mmproj Q8_0) e LFM3-Audio-2B. Os arquivos vêm de `huggingface.co/LiquidAI/<repo>/resolve/main/<file>` para `userData\models\<repo>\`.
  - **Processo:** `llama-server -m <gguf> --mmproj <mmproj> --host 127.0.0.1 --port <livre> --reasoning off -ngl 99 -c 8192 --jinja`. O stdout e o stderr são capturados num log rotativo. O health check é `GET /health`. Se o processo cair, reinicia com backoff, no máximo 3 vezes.
  - **Servidor próprio (D6):** o usuário informa a URL. Nesse caso não há instalação nem start.
- **Tipos:** o status vira `engines: Record<'ollama'|'llamacpp', EngineStatus>`, e o evento `local-runtime:status` ganha `engineId`.
- **Provider:** o `llamacpp` entra em `LLM_PROVIDER_IDS`. Ele também pode servir o chat de texto, via `createOpenAICompatibleModel` contra `http://127.0.0.1:<port>/v1`.

### 7.2 `LiveModeSettings` (substitui os flags omni)

```ts
interface LiveModeSettings {
  backend: 'llamacpp-realtime' | 'llamacpp-hybrid' | 'gemini-live' | 'openai-realtime' | 'cascade'
  llamacpp: { modelId: string; voice: 'female'|'male'; endpoint: 'managed' | { url: string } }
  hybrid:   { referenceVoiceId?: string }
  gemini:   { model: string; voice: string }
  openai:   { model: string; voice: string }
  cascade:  { sttProviderId; llmProviderId: 'chat-default' | LlmProviderId; ttsProviderId; referenceVoiceId? }
  turn:     { vadThreshold; minSpeechMs; endpointMs; graceMs; smartTurn: boolean; pushToTalk: boolean }
  interrupt:{ enabled; bargeInMinMs; falseInterruptionMs; aecWarmupMs }
  devices:  { inputDeviceId?; outputDeviceId? }
  features: { toolsInCall: boolean; visionInCall: boolean; initiativeInCall: boolean; idleNudgeSec: number }
}
```

- **Armazenamento:** `userData\live-mode.json`. As chaves de nuvem ficam no vault existente, com os providers novos `gemini` e o `openai` atual.
- **Migração única:** `unifiedOmniMode`, `directOmniAudio`, `omniExecutionModeOverride` e o pill "Omni Nativo" são **removidos**. Quem tinha native-omni com Ollama passa a ter `backend: 'llamacpp-realtime'`, se o engine estiver instalado; senão vai para `cascade` com o Ollama como LLM.
- **O que fica:** o `omniExecutionMode` do provider continua **só para o chat de texto** (imagem e vídeo na mensagem). O caminho `turn:audio-delta`/`/tts` do Ollama continua apenas como "falar respostas do chat em voz alta".

### 7.3 `LiveSessionContextBuilder` (persona e memória por backend)

O RPC `call:buildContext({sessionId, backend, userText?})` usa o `cortex.compileTurnPrompt`:
- persona estática;
- contexto volátil (identidade, hora, humor);
- memórias recuperadas;
- contexto de agência.

Ele devolve `{ instructions, perTurnContext }` dimensionados por backend:
- **llama.cpp:** compacto, com limite de cerca de 2.700 caracteres (reaproveita `buildCompactLocalOmniSystemPrompt`). Vai no `session.update` **antes do primeiro áudio**, porque depois não dá para mudar. Inclui a instrução de voz em pt-BR e a regra de não ler markers em voz alta.
- **Nuvem:** a persona completa, estática e volátil.

**Atualização de memória por turno:** quando há uma transcrição final do usuário, o engine chama `call:buildContext({userText})` e injeta `perTurnContext` (memórias relevantes, nota de interrupção, contexto de tela) antes do `respond()`. O mecanismo depende de `caps.contextInjection`:

| Backend | Mecanismo |
|---|---|
| llama.cpp | `conversation.item.create` com `input_text` iniciado por `[Contexto]` |
| OpenAI | `session.update.instructions` + `response.create` com `create_response=false` |
| Gemini | `clientContent` com `turnComplete:false` |

**Orçamento:** a busca de memória precisa caber em ~150 ms. Se estourar, o turno segue sem as memórias novas.

Atenção: o `compileTurnPrompt` grava um efeito colateral de humor. É preciso adicionar um modo `dryRun`/`sideEffects:false` para as chamadas de contexto, e o efeito passa a acontecer **uma vez** por turno, no `recordTurn`.

### 7.4 `CallRecorder`: persistência (D7)

- **Migração do cortex `v6`:** `chat_messages` ganha `modality TEXT DEFAULT 'text'`, `interrupted INTEGER DEFAULT 0` e `meta_json TEXT`.
- **`cortex.appendVoiceTurn({sessionId, userTranscript, assistantSpokenText, interrupted, backendId, markers, metrics})`:**
  1. grava as duas mensagens;
  2. aplica a reação afetiva;
  3. roda `indexTurnMemory`, `reviewTurnMemories` e `consolidateSessionMemories`;
  4. emite `chat:appended` para o hub atualizar o chat sem precisar de snapshot.
- O `sanitizeConversationHistory` da 10.0 passa a ler `interrupted` (para anexar "…") e `modality`.

### 7.5 `CallToolRouter` (D8)

- **Tools disponíveis:** só quando `features.toolsInCall && caps.toolCalls`. É o mesmo conjunto de `buildAgencyChatTools`, com JSON Schema via `valibotSchemaToJsonSchema`, mais o `ashy_stage_signal` quando a emoção usa o caminho 2.
- **Execução:** `tool_call` → RPC `call:executeTool({callId, name, args})` → `executeGatekeptMcpTool`.
  - Resultado `executed`: vai como tool result.
  - Resultado `staged`: o tool result é `{"status":"aguardando_aprovacao","resumo":"…"}`, e o modelo diz que precisa de permissão.
- **Eventos novos:** `agency:pending {card}` e `agency:resolved {cardId, status, output}`. O overlay e o hub mostram o card **durante** a chamada. Quando aprovado, o resultado entra como `injectContext("[Ação aprovada: …resultado…]")` e um `respond()`.
- **Modelos fracos em tools:** o LFM3-2B é fraco nisso. As tools dele vão em versão enxuta (as 4 mais úteis, com descrições curtas), e o usuário pode desligar.

### 7.6 `VisionDescriber` e captura de tela real (D9)

- **Fonte real de tela:** `desktopCapturer` no main com `setDisplayMediaRequestHandler`, mais `getDisplayMedia` na janela call-engine. Respeita o `eyesMode` (`off|window|screen`). Substitui a captura sintética no contexto da chamada.
- **Pipeline:** um `createFrameSampler(source)` generalizado a partir do sampler de webcam (dHash e JPEG). Na chamada, captura no máximo 1 frame a cada 2 s, e só quando muda.
- **Backends com `imageInput`:** `sendImage`.
- **llama.cpp:** o frame vai ao `/v1/chat/completions` do próprio llama-server (o mmproj tem visão), com "descreva em 1 frase o que está na tela". O texto entra via `injectContext("[Tela] …")`, e só antes de um `respond()`, nunca no meio de uma fala.

### 7.7 Iniciativa na chamada (D10)

- **Gatilho:** silêncio contínuo em `listening` por `idleNudgeSec` (padrão 90 s). O engine chama o `evaluateAttentionInitiative({idleMinutes, recentUserMessage, localTimeHHMM})` existente.
- **Se a decisão for `spoken`** e não houver mute nem DND: `injectContext("[Iniciativa] <motivo>")` seguido de `respond()`.
- **Limites:** valem o cooldown, o teto diário e as horas de silêncio do motor. Na chamada há um cooldown extra (no máximo 1 iniciativa a cada 10 min).
- `[SILENCE]` ou um descarte não geram nada.

### 7.8 `CallStateHub` e RPCs

- **Controle:** `call:start({backend?})`, `call:stop`, `call:setMuted`, `call:getState`, `call:mintToken`, `call:buildContext`, `call:recordTurn`, `call:executeTool`, `call:classifyAffect`, `call:describeFrame`.
- **Voz de referência:** `liveVoice:list|import|delete|preview`.
- **Eventos:**
  - `call:state {status, muted, backend, caption?, metrics?, reason?}`, emitido em toda transição;
  - `call:viseme` (≤ 30 Hz);
  - `chat:appended`;
  - `agency:pending|resolved`.
- **Dono do estado:** o host. A janela call-engine relata as transições; hub e overlay só leem e enviam RPCs.
- **IPC:** o `call:viseme` vai **só por IPC**, e não também pelo SSE, para não serializar duas vezes.

### 7.9 `VoiceReferenceStore` (D3)

- **Upload** de WAV, MP3 ou FLAC entre 5 e 30 s.
- **Normalização** para WAV mono de 24 kHz, com corte de silêncio e checagem de duração.
- **Armazenamento:** `userData\voices\<id>.wav` mais `voices.json` (nome, duração, data).
- **Prévia:** um botão "Ouvir" sintetiza uma frase de teste com o backend selecionado.
- **Aviso de consentimento:** "Use só vozes que você tem direito de usar."
- **Onde é usada:**
  - `LlamaCppHybridSession`: `/tts` com `speaker_ref_b64`;
  - cascata com TTS clonável: llama.cpp `/tts` com LFM3-Audio, ou futuros como o Chatterbox.

---

## 8. Backends

### 8.1 `LlamaCppRealtimeSession` (10.1)

**O modo de entrada é configurável: `transcribed` (padrão) ou `audio-direct` (experimental).** O padrão vem do spike da §4.

1. Abre o WS em `ws://127.0.0.1:<port>/v1/realtime?model=<id>`, lê `session.created` (de onde saem as taxas) e espera `session.updated` antes de enviar qualquer entrada.
2. Envia `session.update {instructions, output_modalities:["text","audio"], max_output_tokens, tools?, tool_choice:"auto"}`. As instructions seguem o formato do model card: persona curta em inglês, `Always respond in Brazilian Portuguese`, e `Respond in interleaved text and audio.` como última linha.
3. **Modo `transcribed`:**
   1. o VAD local detecta o fim do turno;
   2. o WAV do turno vai para a transcrição (ordem: `ollama-transcriptions`, depois o STT configurado, depois a ASR do próprio llama-server);
   3. `conversation.item.create` envia o input_text `[Contexto] …memórias/tela/nota de interrupção…`;
   4. `conversation.item.create` envia o input_text com a transcrição;
   5. `response.create`.
4. **Modo `audio-direct`:** o microfone vai como `input_audio_buffer.append`, só a partir do VAD onset (com pre-roll), em chunks de 40–100 ms na taxa de entrada. No fim do turno: `commit`, depois o contexto, depois `response.create`. A transcrição do usuário roda em paralelo (§6.4).
5. **Watchdog:** limite de `max_output_tokens`; `response.cancel` quando o áudio passar de 3× a duração estimada pelo texto ou de 45 s; detector de repetição no texto.
5. Ao receber deltas: `response.output_audio.delta` (base64 PCM16 de 24 kHz) vai para o player; `response.output_text.delta` vai para a legenda, o ledger e o parser de ACT.
6. Na interrupção: `response.cancel` no backend e fade no player local.
7. Ciclo de vida da sessão: uma sessão por chamada. A sessão é rotacionada quando o contexto passa de ~70% de `-c`, com a contagem de tokens estimada pelo ledger. A sessão nova é semeada com o resumo do ledger e as últimas N trocas, via `input_text`.

**Restrição:** áudio já enviado não pode ser descartado. Por isso o engine só envia áudio depois do VAD onset, com pre-roll; ruído antes da fala não sobe.

### 8.2 Aprovação por voz (D8)

Com um card pendente, se a transcrição do usuário (§6.4 ou `userTranscription` do backend) bater **deterministicamente** com uma frase de aprovação, o engine chama `approvePendingAction`. As frases reconhecidas: "pode", "pode fazer", "sim, pode", "aprovado", "autorizo". Negações ("não", "cancela") chamam `deny`.

**O modelo nunca aprova sozinho:** não existe tool de aprovação. Ações de risco `staged-confirm` com `blastRadiusWarning` exigem **clique**.

### 8.3 `LlamaCppHybridSession` (10.2)

- **Áudio da resposta:** a mesma sessão realtime, com `output_modalities:["text"]`. Cada frase completa do texto vai, pelo chunker existente, para `/tts` com `speaker_ref_b64`, em paralelo e em ordem (`RealtimeSpeechPipeline`).
- **Custo:** latência maior que o realtime nativo. Em troca, a voz é a voz de referência do usuário.

### 8.4 `GeminiLiveSession` / `OpenAIRealtimeSession` (10.4)

- **Gemini:**
  - setup com `systemInstruction`, `tools`, `speechConfig.voiceConfig` (voz) e `realtimeInputConfig` (VAD do servidor);
  - transcrição de entrada e de saída ativada;
  - `interrupted` vira fade local + nota de contexto;
  - `GoAway` / 15 min → resumption + compression.
- **OpenAI:**
  - WS com token efêmero;
  - `session.update {instructions, voice, turn_detection:{type:'semantic_vad', create_response:false}, input_audio_transcription}`;
  - barge-in via `conversation.item.truncate {item_id, content_index:0, audio_end_ms}`.
- **Os dois:**
  - imagens via `sendImage`;
  - tools via `CallToolRouter`;
  - o seletor de vozes do provedor substitui a voz de referência.

### 8.5 `CascadeSession` (10.5)

- **Componentes:**
  - **STT:** `ollama-transcriptions` (10.0), `local-whisper-http` ou um whisper.cpp gerenciado (uma segunda variante do `LlamaCppEngine`: o binário `whisper-server` do whisper.cpp; **[a verificar na 10.5]**). Alternativas na nuvem: Groq/OpenAI.
  - **LLM:** o chat padrão ou um provider escolhido, em streaming.
  - **Chunker:** com boost (os 2 primeiros chunks podem cortar em vírgula).
  - **TTS:** em paralelo e em ordem. Opções: llama.cpp `/tts` (LFM3-Audio, com referência opcional), `local-kokoro-http`, ElevenLabs, OpenAI TTS.
- **Contrato:** emite os mesmos eventos de `VoiceSession`. Para o engine, a cascata é só mais um backend.

---

## 9. UI

### 9.1 Botão de chamada (D5)
- **Hub:** o orb "Conversar por voz" vira **Ligar/Desligar**, com anel de estado:
  - ouvindo: verde;
  - você falando: pulso;
  - pensando: spinner;
  - falando: ondas;
  - reconectando: âmbar.
- **Durante a chamada:** mute, legenda ao vivo e chip de latência.
- **Atalho global:** `Ctrl+Alt+L`, para ligar e desligar.

### 9.2 Overlay (D11)
- **Ilha de controles** (`data-ui-island`):
  - `btn-call-toggle`;
  - `btn-call-mute`;
  - um ponto de estado, que **fica visível mesmo sem hover** durante a chamada.
- **Card de aprovação:** o card pendente aparece no balão já existente.
- **Lip-sync:** vem de `call:viseme`.

### 9.3 Configurações → **Live Mode** (aba nova)
1. **Backend:** cards com os presets e a seção de cada um.
   - **Local omni (LFM3 via llama.cpp)**
     - estado do motor (instalado, rodando, GPU, variante);
     - botão "Instalar (≈1,7 GB)" com progresso;
     - escolha do modelo;
     - voz feminina ou masculina;
     - toggle "usar minha voz de referência (modo híbrido; mais latência)".
   - **Nuvem realtime (Gemini / OpenAI)**
     - chave (vault);
     - modelo;
     - seletor de voz;
     - aviso de custo estimado por minuto e de que o áudio vai para o provedor.
   - **Cascata:** STT, LLM e TTS, cada um com o seu teste.
2. **Voz de referência:** lista, upload, ouvir e excluir. Só aparece quando o backend selecionado suporta (`speakerReference`).
3. **Turnos e interrupção:**
   - limiar do VAD com **medidor ao vivo** (probabilidade em tempo real);
   - endpoint, grace e pre-roll;
   - smart-turn;
   - push-to-talk e o atalho;
   - barge-in: liga/desliga, duração mínima, retomar em interrupção falsa e aquecimento do AEC.
4. **Dispositivos:** entrada e saída (`setSinkId`) e o status do AEC/NS.
5. **Recursos na chamada:** ferramentas, visão e iniciativa (com intervalo).
6. **Teste de chamada:** uma chamada de 1 turno com a frase fixa "Oi Ashy, tudo bem?". Mostra as métricas da §6.6 e um ✓ ou ✗ para cada etapa (mic, VAD, backend, primeira resposta, playback).

### 9.4 Chat
- **Marcação:** mensagens de voz levam um ícone 🎤. As interrompidas terminam em "…" e trazem o tooltip "interrompida".
- **O que sai:** o pill "Omni Nativo" e o switch `directOmniAudio` deixam de existir.

---

## 10. Segurança e privacidade

- **Chaves:** nenhuma chave de nuvem vai ao renderer. Só tokens efêmeros, com TTL ≤ 60 s para abrir a sessão.
- **Sidecar local:** o llama-server escuta só em `127.0.0.1`, numa porta aleatória.
  - Antes de aceitar que um servidor é o "nosso", o health check confere o PID filho gerenciado.
  - O servidor próprio do usuário é marcado como não gerenciado.
- **Downloads:** apenas de URLs fixas no código (GitHub releases do ggml-org e HF do LiquidAI), com SHA256 verificado no binário e tamanho e SHA verificados nos modelos. O arquivo é extraído para um diretório novo; arquivos fora do esperado são rejeitados.
- **Visão:** a de tela respeita o `eyesMode` e mostra um indicador visível ("👁 vendo a tela") enquanto a chamada estiver capturando.
- **Voz de referência:** fica local, e a UI traz o aviso de consentimento.
- **Wireback `scripts/verify-phase10-wireback.mjs`:**
  - proíbe chaves e `providers.secrets` no renderer;
  - proíbe `turn:audio-delta` no CallEngine;
  - exige o tratamento de `call:state` no hub e no overlay;
  - exige o pin de SHA no download do llama.cpp.

## 11. Fases de entrega

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **10.1 Chamada local ponta a ponta** | `EngineManager` + `LlamaCppEngine` (GPU, download, start); `LiveModeSettings` com migração; janela call-engine + `CallStateHub`; CallEngine (estados, Silero VAD, player, ledger básico); `LlamaCppRealtimeSession`; `buildContext` (instruções compactas); `recordTurn` + migração v6 + transcrição do usuário (§6.4); botão Ligar no hub e no overlay; aba Live Mode mínima (backend local + instalar + voz). | O Carlos liga, conversa por 5 minutos com o LFM3 local, ouve a voz dela, vê a boca mexendo, e as falas aparecem no chat e na memória. |
| **10.2 Qualidade da conversa** | Barge-in completo (ducking, interrupção falsa, AEC warm-up); histórico fiel com nota de interrupção; memória por turno; emoção por camadas; métricas + teste de chamada; **modo híbrido + VoiceReferenceStore**; smart-turn opcional; rotação de sessão. | Interromper a Ashy no meio de uma frase faz o histórico mostrar só o que foi ouvido, e a resposta seguinte reconhece o corte. Com voz de referência, o modo híbrido fala com ela. |
| **10.3 Agência, visão e iniciativa** | `CallToolRouter` + `agency:pending/resolved` + aprovação por voz; captura de tela real + `VisionDescriber`; iniciativa na chamada. | "Ashy, o que tem na minha tela?" funciona no local; uma ação de arquivo pede aprovação por voz e executa; depois de 90 s de silêncio com um motivo concreto, ela puxa assunto. |
| **10.4 Nuvem realtime** | Providers `gemini` e OpenAI Realtime; `CloudTokenMinter`; CSP; `GeminiLiveSession` + `OpenAIRealtimeSession` (truncate, resumption). | A mesma chamada funciona trocando só o backend nas configurações. |
| **10.5 Cascata** | `CascadeSession`; whisper.cpp gerenciado (se viável); TTS clonável. | A chamada funciona com qualquer LLM de texto (ex.: Claude/Qwen via Ollama). |
| **10.6 Fechamento** | E2E Flow 6 "Live Call" com mock de `/v1/realtime`; `verify-phase10-wireback`; **ADR-0008** (substitui partes do ADR-0005); USER_GUIDE e PROVIDER_GUIDE; remoção do código omni legado sem uso. | Suíte verde; documentação atualizada. |

**Cada fase segue o ciclo** plano → subagentes → verificação real → commit → `git pull` + reinstalação em `C:\Users\carlos\Documents\agents\ashy`.

## 12. Riscos e validações

| Risco | Mitigação / validação |
|---|---|
| `/v1/realtime` no Windows. | ✅ **Funciona** (spike da §4, com o build embutido no Ollama). Na 10.1, repetir com o upstream `b12024` CUDA e o mmproj Q8_0. |
| Áudio de entrada pt-BR ruim no LFM3 (repete a pergunta, troca o idioma). | O modo padrão é `transcribed` (§8.1). O `audio-direct` fica experimental até ser revalidado. |
| Fala descontrolada (322 s observados). | Watchdog obrigatório (§8.1, item 5) e teste dedicado. |
| Sotaque PT-PT do LFM3. | Avaliar as amostras (`scratchpad\spike-good-answer-ptbr.wav`, `tts-female-sample.wav`). Se não agradar, o modo híbrido usa a voz de referência; nuvem e cascata continuam disponíveis. |
| Modelo de 2B fraco em persona, tools e memória. | Instruções compactas; tools enxutas; o usuário pode trocar de backend (D1). O ledger e o cortex mantêm a identidade fora do modelo. |
| AEC com alto-falantes: ela se ouve. | AEC warm-up, ducking, limiar mais alto durante a fala. A UI recomenda fone. |
| Contexto do llama.cpp imutável depois do primeiro áudio. | Contexto por turno via `input_text`; rotação de sessão semeada pelo ledger. |
| Download grande (~1,7 GB + ~200–400 MB do binário CUDA/cudart). | Retomada, progresso, e escolha de CPU/Vulkan para quem não tem NVIDIA. |
| Gemini sem truncate. | Nota de contexto; o ledger é a fonte da verdade. |
| Silero via `onnxruntime-web` no Electron (WASM, threads). | Fallback para o VAD DSP híbrido da 10.0; teste de carga do worker. |

## 13. Pontos de integração (do mapeamento de código, HEAD `d8b66f7`)

| Área | Onde fica |
|---|---|
| Runtime local | `apps/desktop/src/host/local-runtime-manager.ts` (classe l.116; install l.298; pull l.391); kernel `kernel.ts:1115-1148, 2918-2948`; RPCs `host-protocol.ts:1882-1891`, `vite-host-plugin.ts:125-130/776-818`, `main/index.ts:537-560`, `preload/index.ts:58-62/181-206`, `ashy-host-client.ts:499-512/866-879`. |
| Providers | `LLM_PROVIDER_IDS` `host-protocol.ts:23-32`; configs `host-protocol.ts:~2376`, `provider-vault.ts:66-105`; adapter `provider-vault.ts:538-593`; CSP `apps/desktop/index.html:8`. |
| Flags omni a remover | `host-protocol.ts:44-51, 405-406, 705-744, 1975, 2432-2486`; `provider-vault.ts:412-418`; `kernel.ts:549-553, 1281-1285, 2173-2177`; `turn-orchestrator.ts:831-836`; store `useAshyStore.ts:530-531, 2346, 3747, 5942-6080, 6163`; `voice-session-runtime.ts` (ramos `directOmniAudio`); `App.tsx:1107-1112, 5134-5137`; `ModelsSettingsPanel.tsx:223-254`; `FirstMeetingWizard.tsx:256-271, 620, 679`. |
| Prompt e memória | `cortex.compileTurnPrompt` `packages/cortex/src/ashy-cortex.ts:419-520` (efeito de humor l.431); `soul-composer.ts:234/317/514`; compacto `ollama-native-audio-bridge.ts:518-583`. |
| Persistência | `chat_messages` `packages/cortex/src/db/cortex-db.ts:713-726`; migrações l.349-369/580; insert l.2128-2211. |
| Agência | `packages/agency/src/action-gatekeeper.ts:686`; `agency-runtime.ts:1320/1341`; `buildAgencyChatTools` `turn-orchestrator.ts:110-254`; UI `App.tsx:616-705`. |
| Iniciativa | `evaluateAttentionLoop` `packages/cortex/src/initiative/attention-loop.ts:151`; RPC `kernel.ts:1957-2010`. |
| Visão | `omni-media-sampler.ts:105`; captura sintética `agency-runtime.ts:518-552`. |
| Overlay e janelas | `main/index.ts:706-763`; `electron/main.ts:18-36`; quick controls `App.tsx:526-600`. |
| Stage | `AshyStageCanvas.tsx:399-421`; `live2d-bridge.ts:49-91`; `acoustic-lip-sync.ts:145`. |
| Voz (reuso) | Captura `voice-session-runtime.ts:209`; player l.722 (`attachAudioContext` l.1046); Silero `vad-engine.ts:279`; `turn-policy.ts:34/214`; `speech-pipeline.ts:30/103`. |
| Testes | Vitest com `// @vitest-environment jsdom`; `phase-10-x-*.test.ts(x)` em `apps/desktop/src/__tests__`, e `voice-phase10-x-*` em `packages/voice/test`. O kernel usa um `userDataDir` temporário. E2E em `apps/desktop/e2e`, mock em `e2e/helpers/local-ai-test-server.ts`. |
