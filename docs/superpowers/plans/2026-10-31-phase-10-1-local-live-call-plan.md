# Phase 10.1: local call de ponta a ponta (LFM3-Omni via llama.cpp)

> **Spec:** `docs/superpowers/specs/2026-10-31-phase-10-live-call-engine-design.md`. A 10.1 está na §11; as seções que importam aqui são §4, §5, §6.1–6.5, §7.1–7.4, §7.8, §8.1 e §9.1–9.3.
> **Contrato compartilhado (já escrito):** `packages/shared/src/live-call-protocol.ts`. Os tipos, schemas, RPCs e eventos são a fonte da verdade. Mudar o contrato exige acordo com o integrador.
> **Critério de pronto:** o Carlos liga, conversa 5 minutos com o LFM3 local, ouve a voz dela, vê a boca mexer, e as falas aparecem no chat e na memória.

## Princípios
- **Um RPC genérico.** Tudo que é Live Call passa por `liveCall:invoke {method, payload}`. Do lado do host, um `LiveCallRegistry` despacha cada método para um handler registrado por módulo. Os eventos saem por `emitHostEvent` com os tipos de `LiveCallHostEvent`.
- **A janela oculta `call-engine` é a dona da chamada:** microfone, VAD, sessão WS e playback. O hub e o overlay só leem `call:state`/`call:viseme` e chamam `call:start|stop|setMuted`.
- **Sessão llama.cpp no modo `transcribed`,** conforme o spike da §4. O padrão de instructions é: persona em EN, depois "Always respond in Brazilian Portuguese", e `Respond in interleaved text and audio.` como última linha. O contexto em PT entra como `input_text`. O watchdog é obrigatório.
- **Nada de flags omni novas.** Por enquanto, o caminho de chat e omni antigo continua intacto. A remoção fica para a 10.6.

## Ondas e tarefas

### W0: plumbing do RPC e dos eventos (sequencial, antes de tudo)
- **`host-protocol.ts`:**
  - `export * from './live-call-protocol'` no `index.ts` do shared.
  - Adicionar `'liveCall:invoke'` em `ASHY_HOST_RPC_METHODS`.
  - Adicionar `invokeLiveCall?(input: LiveCallInvokeInput): Promise<unknown>` em `AshyHostBridge`.
  - Estender `AshyHostStreamEvent` com `LiveCallHostEvent`, e o `AshyHostStreamEventSchema` com schemas para os 5 eventos novos.
- **Transporte:** `vite-host-plugin.ts` (allowlist + dispatch → `kernel.invokeLiveCall`), `main/index.ts` (o canal IPC genérico já cobre), `preload/index.ts`, `ashy-host-client.ts` (as duas bridges).
  - `call:viseme` é **só IPC**. No SSE é filtrado, para não serializar duas vezes. No modo HTTP (dev) não há viseme.
- **Kernel:**
  - `createLiveCallRegistry()` em `apps/desktop/src/host/live-call/registry.ts`, com `register(method, handler)` e `invoke(method, payload)`. Método desconhecido ou sem handler gera um erro tipado `LIVE_CALL_METHOD_UNAVAILABLE`.
  - `kernel.invokeLiveCall` e `kernel.liveCall = { registry, emit(event) }`, expostos para os módulos se registrarem.
  - **Ponto de extensão** para o main: `kernel.setCallWindowController({ ensure(): Promise<void>, destroy(): void } | null)`.
- **Testes:** dispatch genérico pelos dois transportes (IPC preload e HTTP), erro de método sem handler, e o viseme não indo ao SSE.

### W1 (paralelo, depois da W0)

#### A: `LlamaCppEngine` + settings — `apps/desktop/src/host/engines/**`, `apps/desktop/src/host/live-call/settings.ts`
- **Detecção de GPU:** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`. Se houver NVIDIA, a variante é `cuda-12.4`. Senão, `Get-CimInstance Win32_VideoController`: AMD ou Intel vão para `vulkan`. O fallback é `cpu`. Tudo injetável (`execImpl`).
- **Download:**
  - streaming com `Range` para retomar, no arquivo `*.part`;
  - progresso throttled num evento `engine:status`;
  - SHA256 em streaming (`crypto.createHash`) comparado com o pin;
  - em caso de erro, apaga o `.part`;
  - **só as URLs pinadas do contrato**.
- **Extração do zip:**
  - `tar -xf` (bsdtar, nativo no Win10+) para um diretório novo vazio, `userData\engines\llama.cpp\<build>-<variant>\`;
  - rejeitar entradas com `..` ou caminhos absolutos;
  - validar que `llama-server.exe` existe.
  - Na variante CUDA, os dois zips vão para o mesmo diretório.
- **Modelos:**
  - Antes de baixar, procurar o mesmo SHA no **blob do Ollama**: `%USERPROFILE%\.ollama\models\blobs\sha256-<sha>` (ou `OLLAMA_MODELS`). Se existir, tentar um hardlink (`fs.link`) para `userData\models\<repo>\<fileName>`; se falhar, usar o caminho do blob direto (registrado em `models.json`).
  - Senão, baixar.
  - O mmproj Q8_0 sempre vem do HF.
- **Processo:**
  - comando: `llama-server.exe -m <gguf> --mmproj <mmproj> --host 127.0.0.1 --port <porta livre> --reasoning off -ngl 99 -c <contextSize> --jinja --no-webui`;
  - `stdout`/`stderr` vão para `userData\logs\llama-server.log`, rotacionado a 5 MB;
  - health check em `GET /health` a cada 250 ms, com timeout de 60 s;
  - **crash:** reinicia com backoff (1, 3, 9 s), no máximo 3 vezes;
  - **`stop`:** kill e espera;
  - **`dispose`** no quit do app.
- **Endpoint próprio:** `settings.llamacpp.endpoint = {url}` significa nada de install/start; só health.
- **Status:** `LlamaCppEngineStatus`, com o evento `engine:status` a cada mudança.
- **Handlers:** `engines:getStatus|install|downloadModel|start|stop`.
- **Settings:** `userData\live-mode.json`, com deep-merge, validado com `SaveLiveModeSettingsInputSchema`, e handlers `liveMode:getSettings|saveSettings`.
- **Testes:** `apps/desktop/src/__tests__/phase-10-1-llamacpp-engine.test.ts`, com fetch, exec e spawn fakes. Cobrir:
  - variante por GPU;
  - retomada por Range;
  - SHA inválido, que apaga o arquivo e gera erro;
  - reuso do blob do Ollama;
  - extração rejeitando traversal;
  - args do spawn;
  - health e timeout;
  - restart com backoff;
  - settings com merge e validação.

#### B: serviços de chamada no host + cortex — `apps/desktop/src/host/live-call/{call-hub,context,transcribe,recorder}.ts`, `packages/cortex/**`
- **`call-hub.ts`:** é o estado autoritativo (`CallStateSnapshot`). Handlers:
  - **`call:start`:**
    1. valida que o backend está em `LIVE_BACKENDS_IMPLEMENTED` (senão termina com `backend_not_implemented`);
    2. checa o engine: se não estiver instalado, `ended(engine_not_installed)`; se não estiver rodando, `engines:start`;
    3. resolve o `sessionId` (sessão ativa do chat, ou cria uma);
    4. gera o `callId`;
    5. `windowController.ensure()`;
    6. emite `call:command start` e `call:state connecting`.
  - **`call:stop`:** emite `call:command stop` e passa a `ended(user_hangup)`, depois `idle`.
  - **`call:setMuted`.**
  - **`call:getState`.**
  - **`call:getRuntimeConfig`**, para o callId ativo.
  - **`call:reportState`:** aceito só do `callId` ativo; faz merge e emite `call:state`.
  - **`call:reportViseme`:** reemite `call:viseme`, com throttle de ≤ 30 Hz.
- **`context.ts`, `call:buildContext`:**
  - usa `cortex.compileTurnPrompt` com **`sideEffects:false`** (novo, ver o cortex abaixo);
  - devolve `instructions`: uma persona compacta em **inglês** com o nome Ashy, os traços, a regra de não descrever markers e a regra "never read tags aloud", seguida de `Always respond in Brazilian Portuguese, briefly and naturally (1–3 sentences unless asked).` e, como última linha, `Respond in interleaved text and audio.`, com no máximo ~1200 chars;
  - devolve `perTurnContext`: em PT, `[Contexto]` com as memórias relevantes (≤ 600 chars), a hora local, o humor, e `[Sua fala anterior foi interrompida após: «…»]` quando houver `interruptedAfterText`;
  - orçamento de 150 ms; se estourar, o `perTurnContext` sai sem as memórias.
- **`transcribe.ts`, `call:transcribe`:**
  - reaproveita o STT do host da 10.0 (`ollama-transcriptions` e afins, via a mesma função do kernel);
  - a heurística chat-style faz parte disso;
  - rejeita áudio com menos de 300 ms;
  - devolve `{text, providerId, latencyMs}`.
- **`recorder.ts`, `call:recordTurn`:**
  - `cortex.appendVoiceTurn(...)`;
  - emite `chat:appended`;
  - aplica o efeito afetivo **uma vez** aqui;
  - roda `indexTurnMemory`, `reviewTurnMemories` e `consolidateSessionMemories` como o orchestrator já faz (reaproveitar as funções).
- **Cortex:**
  - **Migração v6** em `cortex-db.ts`: `chat_messages` ganha `modality TEXT DEFAULT 'text'`, `interrupted INTEGER DEFAULT 0` e `meta_json TEXT`. `ChatMessageRecord` ganha `modality?`, `interrupted?` e `metaJson?` (opcionais, para manter a compatibilidade).
  - **`compileTurnPrompt(input, { sideEffects?: boolean })`**, com padrão `true`.
  - **`appendVoiceTurn`:** grava as duas mensagens, user e assistant, com `modality='voice'`. A do assistant leva `content` = só o texto falado, mais `interrupted`, e `meta_json` com `{fullText, playedMs, metrics, backend}`. Transcrição vazia vira `🎤 (fala não transcrita)`.
  - **Histórico:** `sanitizeConversationHistory` (host) passa a excluir `🎤 (fala não transcrita)` e a acrescentar `…` nas mensagens interrompidas.
- **Testes:**
  - `packages/cortex` cobre a migração v6 e `appendVoiceTurn`;
  - `apps/desktop/src/__tests__/phase-10-1-call-host.test.ts`, com um kernel num tmpdir e engine e janela fakes, cobre:
    - o fluxo `start → reportState → recordTurn → stop`;
    - `chat:appended`;
    - o callId errado sendo ignorado;
    - `engine_not_installed`;
    - o formato das instructions (última linha exata);
    - o orçamento do contexto.

#### C: CallEngine no renderer (TS puro) — `packages/voice/src/call/**`
- **`types.ts`:** `VoiceSession` e `VoiceSessionCapabilities` (spec §5.3) e `WebSocketLike` injetável.
- **`call-state-machine.ts`:** a §6.1 completa, como reducer puro, testável sem áudio.
- **`turn-detector.ts`:**
  - usa `createSileroOnnxVadEngine` com `sessionLoader` (pacote `onnxruntime-web`, adicionado em `packages/voice` e em `apps/desktop`);
  - o modelo `silero_vad.onnx` (v5, MIT) fica em `apps/desktop/public/models/` e é carregado por URL;
  - fallback para `createHybridVadEngine`;
  - parâmetros de `settings.turn`;
  - gera os eventos `speech_start(confirmed)`, `speech_end(endpoint)` e `speech_during_playback`.
- **`llamacpp-realtime-session.ts`:** a §8.1 completa.
  - `connect`: WS, `session.created`, `session.update`, espera `session.updated`.
  - Modo `transcribed`: `submitUserText(text, contextText)` gera `conversation.item.create` com o contexto, depois com o texto, depois `response.create`.
  - Eventos `response_audio` (PCM16 de 24 kHz em Int16Array), `response_text` e `response_done`.
  - `cancelResponse`.
  - **Watchdog:** `response.cancel` quando o áudio passa de max(3× a duração estimada pelo texto a 14 chars/s, 4 s) ou de 45 s, ou quando há repetição de n-gramas ou vogal sustentada no texto.
  - Modo `audio-direct` (experimental): `pushAudio` + `commitUserTurn`.
- **`call-engine.ts`:** orquestra captura, detector, sessão, player e host.
  - **`host`** é uma interface injetada: `buildContext`, `transcribe`, `recordTurn`, `reportState`, `reportViseme`.
  - **Captura:** reaproveita `createWebAudioWorkletCapture` e o ring buffer com pre-roll de `voice-session-runtime.ts`. Se precisar, extrair para um módulo exportável sem quebrar a API atual.
  - **Player:** o `createGaplessAudioPlayer` da 10.0, com `attachAudioContext`.
  - **Lip-sync:** o player gera vowel frames sobre o PCM tocado (usar `extractPcmFrameVowelWeights`/vowels no chunk, ou mover o `analyzePcmFrameToVowels` do stage para um utilitário compartilhado). Saem por `reportViseme`, com throttle de 30 Hz.
  - **Ledger:** `itemId` por resposta, texto acumulado e `playedMs` do player. No fim (`response_done` + fila esgotada) ou numa interrupção, chama `recordTurn` só com o texto falado (proporção pela duração tocada).
  - **Barge-in básico** (o completo é da 10.2): em `speaking`, uma fala confirmada ≥ `bargeInMinMs` gera `cancelResponse` + fade de 120 ms + `recordTurn(interrupted)`, e passa a `user_speaking`. No turno seguinte, `buildContext({interruptedAfterText})`.
  - **Métricas** da §6.6.
  - **Mute:** a captura continua, mas o detector é ignorado.
  - **Stop:** fecha o WS, para a captura e encerra o player.
- **Testes:** `packages/voice/test/voice-phase10-1-*.test.ts`, com fake WebSocket servidor (roteiro de eventos), fake AudioContext e fake capture. Cobrir:
  - a sequência do `session.update` (instructions antes de qualquer entrada);
  - a ordem dos itens de contexto e texto;
  - o watchdog cancelando áudio descontrolado;
  - as transições da máquina de estados;
  - o barge-in gravando só o texto tocado;
  - o fallback do VAD sem ONNX.

### W2: janela call-engine + UI (depois da W1)

#### D: Electron + glue + UI — `apps/desktop/src/main/index.ts`, `apps/desktop/src/call-engine/**`, `App.tsx`, store (slice nova `apps/desktop/src/store/useCallStore.ts`), `index.html` (CSP, se precisar)
- **`main/index.ts`:**
  - implementa o `CallWindowController`: uma BrowserWindow `show:false`, `backgroundThrottling:false`, com a mesma preload, `?view=call-engine` e o mesmo `validateIpcSender`. É criada sob demanda e destruída 60 s depois de `idle`.
  - liberar `media` (microfone) só para essa janela, via `session.setPermissionRequestHandler`.
- **`apps/desktop/src/call-engine/boot.ts`:** quando `view=call-engine`, não renderiza a UI. Ele:
  - escuta `call:command`;
  - em `start`, chama `call:getRuntimeConfig`, cria o `CallEngine` (C) com o `host` implementado sobre `invokeLiveCall` e o `LlamaCppRealtimeSession`;
  - em `stop` e `setMuted`, repassa ao engine.
  - Sem preload (dev HTTP), o hub monta o boot inline.
- **`useCallStore.ts`:** `callState`, `viseme`, `engineStatus` e `liveSettings`, assinando `call:state`, `call:viseme` e `engine:status`, com as ações `startCall`, `stopCall`, `setMuted`, `install`, `downloadModel` e `saveLiveSettings`.
  - O `call:viseme` alimenta o stage (`simulatedVowels`/`rawVolume`/`isSpeaking`) **quando há uma chamada ativa**, com prioridade sobre a store antiga.
  - O `chat:appended` dispara o refresh das mensagens da sessão (`selectSession` ou o equivalente leve).
- **UI:**
  - **Hub:** o orb "Conversar por voz" vira **Ligar/Desligar**, com anel de estado (§9.1), mute, legenda ao vivo e chip de latência (`e2eMs`). O atalho `Ctrl+Alt+L` é registrado no main.
  - **Overlay:** `btn-call-toggle`, `btn-call-mute` e um ponto de estado sempre visível durante a chamada (§9.2).
  - **Configurações → aba "Live Mode" mínima:**
    - backend: na 10.1 só "Local omni (LFM3 via llama.cpp)"; os outros aparecem desabilitados com o rótulo "em breve";
    - status do engine (GPU, variante, instalado, rodando);
    - **Instalar motor** e **Baixar modelo**, com progresso, mostrando "reaproveitando arquivo do Ollama" quando for o caso;
    - Iniciar e Parar;
    - voz feminina ou masculina;
    - modo de entrada (transcrito, ou áudio direto marcado como experimental);
    - limiar do VAD e endpoint.
  - Os textos em pt-BR.
- **Testes:** `apps/desktop/src/__tests__/phase-10-1-call-ui.test.tsx` (jsdom) cobrindo:
  - o botão chamando `call:start`;
  - os estados refletidos no hub e no overlay;
  - o progresso de instalação;
  - o roteamento dos comandos pelo boot do call-engine com um engine fake;
  - a criação da janela no main, com um BrowserWindow mockado no estilo dos testes de lifecycle da fase 9.

## Integração (orquestrador)
1. `pnpm typecheck`, `pnpm test` e `pnpm build`.
2. **Verificação real:**
   1. instalar o motor (CUDA) e baixar o mmproj Q8, que deve reaproveitar o GGUF do Ollama;
   2. subir o servidor;
   3. rodar um teste de chamada automatizado com um script Node: o engine com áudio sintetizado pelo `/tts` no lugar do microfone;
   4. medir `e2eMs`.
3. Commits por tarefa, push, e instruções de `git pull` + install para o Carlos.
