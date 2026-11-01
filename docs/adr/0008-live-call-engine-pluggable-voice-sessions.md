# ADR-0008: Motor de Chamada ao Vivo (`CallEngine`) com Janela Oculta Dona da Chamada, `VoiceSession` Plugável por Capabilities e Backends Local / Nuvem / Cascata

- **Status:** Accepted
- **Date:** 2026-11-01
- **Milestone:** Fase 10 (10.0 → 10.6 — Live Mode / Live Call Engine)
- **Substitui parcialmente:** [ADR-0005](./0005-realtime-voice-cas-turn-taking-and-unified-omni-lfm3.md) (itens 2 e 3 da decisão, ver "Relação com o ADR-0005")
- **Spec:** `docs/superpowers/specs/2026-10-31-phase-10-live-call-engine-design.md`

---

## Context

O ADR-0005 descreveu a voz em tempo real como um modo do chat (`native-omni` / `hybrid-omni-in` / `modular`) dentro do `TurnOrchestrator`, com o áudio da resposta vindo como `turn:audio-delta` pelo transporte JSON do host. Em uso real (Fase 9.2 e hotfix 10.0) isso não virou uma conversa por voz:

1. **O Ollama não tem fala→fala.** O "Omni Nativo" no Ollama era ASR → texto → LLM de texto → `POST /tts` no fim do turno inteiro. O Ollama não gera áudio num turno de chat nem tem endpoint realtime (issue ollama#19396 aberta). Não havia streaming: a latência era selamento (750 ms) + ASR + LLM completo + TTS completo.
2. **O player não tinha `AudioContext`.** Nada em `apps/desktop/src` passava um `AudioContext` ao `GaplessAudioPlayer`; os chunks `turn:audio-delta` eram descartados em silêncio e, como "chegou áudio", o fallback de TTS era pulado → silêncio total.
3. **Loop de saudação ("ela responde sempre a mesma coisa").** Causas reproduzidas:
   - o GGUF do LFM3 força decodificação gulosa (`top_k=1`, `temp=0`) e o `/v1/chat/completions` não deixa sobrescrever `top_k`;
   - o histórico reenviava até 80 mensagens com placeholders `[Mensagem de voz Omni]` e respostas quase idênticas, que o modelo de 2B copia;
   - depois, já no Live Mode (10.1/10.2), **envenenamento de memória auto-reforçado**: o recorder e a consolidação determinística gravavam episódios `Usuário: Olá. | Ashy: Olá, Carlos! Tudo bem…` (incluindo ecos), que voltavam como "Memórias relevantes" no `[Contexto]` do turno seguinte; a **rotação de sessão com recap** carregava as falas da própria Ashy; e o mesmo bloco `[Contexto] Hora local … Humor …` em todo turno, sem papéis explícitos, fazia o modelo cumprimentar de novo e chamar o usuário de "Ashy".
4. **Duas janelas reagindo aos mesmos eventos.** Hub e overlay tinham stores separadas e ambas tentavam tocar/reagir ao turno de voz.
5. **STT/TTS falsos eram o padrão** (`deterministic-wav-stt`, tom de 185 Hz), corrigido na 10.0.

O que existe para fala→fala local é o `llama-server` do llama.cpp (≥ 0.8.0) com `/v1/realtime` (WebSocket no estilo OpenAI Realtime), sem VAD no servidor, sem `truncate`, com `instructions`/`tools` imutáveis depois do primeiro item e com o LFM3-Omni-2B repetindo a pergunta quando recebe áudio pt-BR direto (spike de 2026-10-31).

## Decision

### 1. Janela oculta `call-engine` como dona única da chamada

- Microfone (AudioWorklet 16 kHz + ring buffer com pre-roll), detecção de turno (Silero VAD v5 via `onnxruntime-web`, fallback para o VAD DSP híbrido), sessão do backend e playback (um `AudioContext`, `GaplessAudioPlayer` com recibos) vivem numa `BrowserWindow` oculta (`?view=call-engine`, `show:false`, `backgroundThrottling:false`), criada no primeiro `call:start` e destruída depois de um tempo ocioso (`apps/desktop/src/main/index.ts`).
- O **host é o dono do estado**: a janela relata transições (`call:reportState`), o `CallStateHub` (`host/live-call/call-hub.ts`) transmite `call:state` e `call:viseme` (lip-sync a ≤ 30 Hz, só por IPC). Hub e overlay são **apenas views** (`useCallStore.ts`) que mandam RPCs (`call:start|stop|setMuted`).
- A chamada sobrevive ao fechamento do hub; atalho global `Ctrl+Alt+L` (`CALL_TOGGLE_SHORTCUT`).
- O áudio da chamada **nunca** passa por `turn:audio-delta` nem pelo transporte JSON: vai WebSocket → player dentro da janela da chamada.
- Todas as RPCs da chamada passam por um único método genérico `liveCall:invoke` roteado por um registry no host (`packages/shared/src/live-call-protocol.ts`).

### 2. `VoiceSession` + `VoiceSessionCapabilities`

O `CallEngine` (`packages/voice/src/call/call-engine.ts`) não conhece backend nenhum: lê só `session.caps` (`serverTurnDetection`, `serverAutoResponse`, `messageTruncation`, `mutableInstructions`, `contextInjection`, `userTranscription`, `toolCalls`, `inlineToolCalls`, `imageInput`, `speakerReference`, `managesContext`, taxas de entrada/saída). Máquina de estados: `idle → connecting → listening ⇄ user_speaking → thinking → speaking → interrupt_pending → (interrupted) → …`, `reconnecting`, `ended(motivo tipado)`; ducking em `interrupt_pending`, interrupção falsa, aquecimento de AEC, mute e watchdog de fala descontrolada (`runaway-watchdog.ts`).

Backends (`LIVE_BACKEND_IDS`), todos implementados:

| Backend | Sessão | Como funciona |
|---|---|---|
| `llamacpp-hybrid` (**padrão**) | `llamacpp-hybrid-session.ts` | VAD local → WAV → transcrição (`call:transcribe`) → `/v1/realtime` com saída **só texto** → cada frase vai ao `/tts` do llama-server (voz feminina/masculina ou **voz de referência** do usuário), em paralelo limitado (`maxParallelTts`) e tocada em ordem. Guarda de conversa: segura a 1ª frase, corta abertura que repete o usuário, regenera uma vez uma resposta que é só eco, remove "Ashy" dito ao usuário. Migração única 10.5: quem estava em `llamacpp-realtime` (única opção da 10.1) passou para híbrido. |
| `llamacpp-realtime` | `llamacpp-realtime-session.ts` | Mesmo pipeline, mas a resposta sai em `["text","audio"]` intercalado do próprio LFM3 (menor latência; não dá para filtrar o áudio depois). `inputMode: 'transcribed'` (padrão) ou `'audio-direct'` (experimental). |
| `openai-realtime` | `openai-realtime-session.ts` | Qualquer endpoint compatível com OpenAI Realtime: **OpenAI** (`gpt-realtime-2.1-mini`, voz `marin`), **Qwen-Omni via DashScope** (`qwen3.5-omni-flash-realtime`, `Tina`, eventos beta) ou **custom** (`wss://…` ou `ws://127.0.0.1|localhost`). VAD do servidor; OpenAI usa `create_response:false` + contexto por resposta e `conversation.item.truncate` no barge-in. |
| `gemini-live` | `gemini-live-session.ts` | `BidiGenerateContent` (`gemini-3.8-live`, voz `Kore`), VAD do servidor, `interrupted`, transcrições de entrada/saída, contexto via `clientContent` só com o modelo ocioso, `goAway` → resumption. |
| `cascade` | `cascade-session.ts` | STT configurável → **qualquer LLM de texto do vault** pelo `TurnOrchestrator.runVoiceCallTurn` (persona, histórico, memória, tools) → chunker com boost → TTS roteado (`llamacpp-tts`, `local-kokoro-http`, `openai-tts`, `elevenlabs`). Eventos próprios `call:cascade` (não `turn:*`); `caps.managesContext=true`. Validado com `qwen3:4b-instruct` no Ollama como melhor qualidade/tools local. |

### 3. Motor local gerenciado (`LlamaCppEngine`)

- Build **fixado** `b12024`, variantes `cuda-12.4` (+ `cudart`), `vulkan`, `cpu`, escolhidas por detecção de GPU (`nvidia-smi`) e trocáveis pelo usuário; downloads só de URLs fixas no contrato, com retomada (`Range`) e **SHA256 verificado** (binários: digests do GitHub; modelos: LFS oid do HF numa revisão fixada).
- **Reuso dos blobs do Ollama**: se `~/.ollama/models/blobs/sha256-<hash>` (ou `OLLAMA_MODELS`) tiver o mesmo SHA256, o GGUF é ligado/reutilizado em vez de baixado.
- Checagem do **Microsoft Visual C++ 2015-2022 x64** (DLLs ausentes → aviso + instalação em 1 clique do `vc_redist.x64.exe` oficial).
- `llama-server` em `127.0.0.1`, porta livre, health check `/health`, restart com backoff (máx. 3), log em `<userData>\logs\llama-server.log`. Servidor próprio do usuário (URL) é só health-checked.

### 4. Autenticação do motor e relay de chaves de nuvem

- Cada launch gera uma chave aleatória de 32 bytes passada ao llama-server **pela variável de ambiente `LLAMA_API_KEY`** (nunca `--api-key` no argv, visível no Gerenciador de Tarefas). O llama-server exige `Authorization: Bearer` em tudo menos `/health`, inclusive no upgrade do `/v1/realtime`.
- O renderer **nunca vê a chave**: o main injeta o header via `webRequest.onBeforeSendHeaders` (`installScopedRequestHeaders`, um único listener roteado por sessão) **somente** para o `webContents` da janela call-engine e **somente** para a porta loopback atual do motor (`isEngineRequestUrl`).
- Nuvem: as chaves (`openai`, `qwen`, `custom`, `gemini`) ficam cifradas (AES-GCM via `safeStorage`, AAD por provedor) em `<userData>\live-cloud-keys.json`; a UI só grava (`liveMode:setApiKey`) e lê status mascarado. A janela da chamada abre `ws://127.0.0.1:<porta>/cloud/<callId>` num **relay loopback** do host (`host/live-call/cloud-relay.ts`); o main injeta um token de relay por execução (mesmo roteador, só `ws:` para a porta do relay), e o relay conecta ao provedor adicionando `Authorization: Bearer` ou `?key=` (Gemini) do lado do host. Erros de handshake viram códigos `4000+HTTP` (4401, 4429), 4001 sem chave, 4002 inacessível, 4003 chamada não ativa, com motivos redigidos. **A CSP não mudou** (redirect de `ws://` via webRequest é ignorado pelo Chromium, por isso o relay).

### 5. Ledger "só o que foi tocado"

Cada resposta tem um `itemId` e um ledger de texto + ms de áudio. No barge-in, o texto falado é fatiado pela proporção `playedMs / totalAudioMs` (`sliceSpokenText`); na OpenAI vai também `conversation.item.truncate`. Nos demais, o próximo turno recebe `[Sua fala anterior foi interrompida após: «…»]`. Na cascata, o texto da resposta é **apenas** o das frases cujo áudio foi emitido. `call:recordTurn` grava `modality='voice'`, `interrupted` e o texto realmente ouvido (migração v6 de `chat_messages`); texto não tocado e placeholders nunca são persistidos nem reenviados ao LLM.

### 6. Higiene de memória e contexto para modelos pequenos

- `selectCallMemoryLines` (`host/live-call/call-memory.ts`): na chamada entram só fatos semânticos sobre o usuário tocados pela fala e **as falas do próprio usuário** ("Carlos contou: …"), nunca a redação da Ashy; sem saudações, perguntas, placeholders, quase-duplicatas; uma fala passada que não compartilha nenhuma palavra com o enunciado não entra; máx. 3 linhas / 360 caracteres. Não destrutivo: linhas envenenadas ficam no banco e são filtradas na recuperação (`isPoisonedTranscriptMemory`, `conversation-hygiene.ts` no cortex).
- O recorder só manda a resposta da Ashy para a memória quando vale lembrar (`memoryWorthyAssistantText`: sem eco, sem só-saudação, sem quase-repetição); o cortex indexa resumos só do lado do usuário quando pedido e extrai fatos pessoais (`named:<relação>`, `lives_in`, `likes:<coisa>`).
- Instruções com papéis explícitos ("cada mensagem é o que Carlos acabou de dizer… nunca chame Carlos de 'Ashy'", "cumprimente só uma vez", "nunca repita as palavras do Carlos"); hora/humor só no primeiro turno, em mudança de humor ou a cada 10 min. Rotação de sessão só como rede de segurança (`rotateAfterTurns` 40, ou duas quase-repetições **consecutivas**), com recap só dos tópicos do usuário. Eval real (`scripts/eval-live-conversation.mjs`): 43 % → 83 % dos turnos passando em todas as checagens; híbrido 92 %.
- Nuvem: prompt da alma do chat (sem seções de markers/MCP) + nome + últimas 12 mensagens + bloco de modo chamada, ajustável por `cloudContext`.

### 7. Ferramentas na chamada

- Só com `features.toolsInCall` (desligado por padrão) e nunca numa chamada de teste. Conjunto **enxuto** de 4 tools (`get_active_window_title`, `capture_authorized_screen`, `read_workspace_file`, `write_project_note`), executadas pelo gatekeeper existente (`call:executeTool`).
- **LFM3 (llama.cpp): fluxo em duas etapas.** Uma política de intenção (`decideToolChoice`) decide por turno; um turno de ferramenta começa com um **passo só-texto** `tool_choice:'auto'` (respostas com áudio nunca chamam tools no LFM3), as chamadas são executadas e os resultados devolvidos, e então a resposta falada é pedida com `tool_choice:'none'` (≤ 3 rodadas). Um passo sem chamadas não é regerado: o texto dele é falado.
- Nuvem: tools dentro da própria resposta falada (`caps.inlineToolCalls`, ≤ 3 rodadas). Cascata: loop de tools do orquestrador no turno do host, com a mesma política e as mesmas 4 tools.

### 8. Aprovações por voz com frases determinísticas

- Ações `staged` geram eventos push `agency:pending` / `agency:resolved`; o card aparece no hub e no balão do overlay com **Aprovar / Sempre permitir / Negar**. "Sempre permitir" grava uma regra de permissão para a tool (nunca para ações com aviso de blast radius).
- Aprovação por voz é um **casamento exato do enunciado inteiro**, feito no host: `pode`, `pode fazer`, `sim pode`, `autorizo`, `pode sim`… (com correções de grafia do ASR como "podi" → "pode"); `pode sempre` / `sempre permitir` = sempre; `não`, `cancela`, `deixa`, `negado` = negar. Vale só para cards `voiceApprovable` criados **pela mesma chamada**. "Pode me contar uma piada" não aprova nada.
- O modelo **nunca aprova**: não existe tool de aprovação. Ações com `blastRadiusWarning` exigem clique. Enquanto houver ação pendente, o contexto diz que ela **ainda não** foi feita.

### 9. Visão

- Captura real via `desktopCapturer` no main (`ScreenCaptureProvider`); o **host** decide se pode capturar (`eyesMode` + consentimento de janela do `PrivacyController`) e descreve o PNG com o **mesmo llama-server** (`/v1/chat/completions` + `image_url`, 1 frase em pt-BR, cache de 30 s). O texto entra como contexto antes da resposta; indicador "👁 vendo a tela" durante a captura.
- Com `features.visionInCall` e intenção visual na fala ("o que tem na minha tela?"), o host descreve a tela; com tools ligadas, o modelo usa `capture_authorized_screen`. As sessões de nuvem implementam `sendImage`, mas o engine ainda **não envia imagens** a elas.

### 10. Iniciativa

Com `features.initiativeInCall`, após `idleNudgeSec` (padrão 90 s) de silêncio em `listening`, o engine pergunta `call:checkInitiative`; o host decide com o motor de atenção existente (política, DND, horas de silêncio, cooldown, teto diário) mais um cooldown próprio da chamada (≤ 1 a cada 10 min), e nunca fala com mute, DND ou em chamada de teste. A frase é gerada pelo próprio modelo da chamada.

## Consequences

### Positivas
- **Uma chamada contínua de verdade**, mãos-livres, com barge-in, lip-sync a partir do áudio tocado e transcrições no chat/memória como mensagens de voz.
- **Backend trocável sem tocar o motor**: local (híbrido/realtime), nuvem (OpenAI/Qwen/custom, Gemini) ou cascata com qualquer LLM de texto; a UI é guiada por capabilities (voz de referência só onde há `speakerReference`, seletor de vozes do provedor na nuvem).
- **Segredos fora do renderer**: chave do llama-server por env + header injetado só na janela da chamada; chaves de nuvem cifradas e usadas só pelo relay do host. Garantido por `scripts/verify-phase10-wireback.mjs`.
- **Histórico fiel**: o que foi interrompido fica cortado no ponto ouvido; nada não tocado vira memória.
- **Modelos de 2B utilizáveis**: higiene de memória e prompts com papéis acabaram com o loop de saudação (eval real 43 % → 83 %).

### Negativas / Trade-offs
- **Mais um processo e uma janela**: o llama-server gerenciado (≈1,6 GB de modelo + 25 MB–670 MB de binário por variante) e a janela oculta consomem RAM/VRAM durante a chamada.
- **Latência local maior que a meta da spec**: com GPU compartilhada, a cascata mediu ~5,5 s fim-da-fala→áudio com LFM3 como LLM; o primeiro turno paga o carregamento do modelo. O híbrido troca latência por controle (filtra eco antes do TTS).
- **`llamacpp-realtime` não é filtrável** (áudio gerado junto do texto) e mantém o "molde" da primeira resposta; por isso o híbrido é o padrão.
- **AEC com alto-falantes** ainda deixa a Ashy se ouvir em alguns ambientes: recomenda-se fone.
- **Nuvem validada só contra servidores falsos** (não havia chave na máquina de desenvolvimento): ids de modelo/voz e payloads reais precisam de validação com chave.
- **Legado do ADR-0005 ainda no código**: os flags `unifiedOmniMode` / `directOmniAudio` / `omniExecutionModeOverride` e os ramos `turn:audio-delta` do chat continuam existindo (servem o chat de texto e "falar respostas do chat"); a remoção prevista na spec 10.6 não foi feita.

## Relação com o ADR-0005

- **Continua valendo:** item 1 (ring buffer com `HistoryLease` de pre-roll, turn-taking do chat por voz fora da chamada) e o `PlaybackReceipt` como mecanismo.
- **Substituído para a conversa por voz:** item 2 (barge-in) passa a ser feito pelo `CallEngine` com o ledger "só o que foi tocado" desta ADR (`interrupt_pending` + ducking, interrupção falsa, truncate/nota de interrupção), e não pelo player do chat; item 3 (tri-modo `native-omni` / `hybrid-omni-in` / `modular` dentro do `TurnOrchestrator` e áudio via `turn:audio-delta`) é substituído pelos backends de `VoiceSession` desta ADR. O "Omni Nativo" do Ollama **não** é fala→fala; o `omniExecutionMode` do provider fica só para o chat de texto (imagem/vídeo na mensagem) e para falar respostas do chat em voz alta.

## Codebase References
- `packages/shared/src/live-call-protocol.ts` (settings, backends, assets fixados com SHA256, RPCs, eventos)
- `packages/voice/src/call/` (`call-engine.ts`, `call-state-machine.ts`, `turn-detector.ts`, `runaway-watchdog.ts`, `llamacpp-realtime-session.ts`, `llamacpp-hybrid-session.ts`, `openai-realtime-session.ts`, `gemini-live-session.ts`, `cloud-session-factory.ts`, `cascade-session.ts`, `types.ts`)
- `apps/desktop/src/call-engine/boot.ts`, `apps/desktop/src/call-engine/cascade.ts`
- `apps/desktop/src/main/index.ts` (janela call-engine, `installScopedRequestHeaders`, `Ctrl+Alt+L`), `apps/desktop/src/main/screen-capture.ts`
- `apps/desktop/src/host/engines/llamacpp-engine.ts`, `apps/desktop/src/host/engines/handlers.ts`
- `apps/desktop/src/host/live-call/` (`handlers.ts`, `call-hub.ts`, `context.ts`, `call-memory.ts`, `recorder.ts`, `cloud.ts`, `cloud-relay.ts`, `cascade.ts`, `tools.ts`, `approvals.ts`, `vision.ts`, `initiative.ts`, `voices.ts`, `synthesize.ts`, `transcribe.ts`, `test-call.ts`, `settings.ts`)
- `packages/cortex/src/` (`conversation-hygiene.ts`, migração v6 de `chat_messages`, `appendVoiceTurn`)
- `apps/desktop/src/store/useCallStore.ts`, `apps/desktop/src/components/LiveCallControls.tsx`
- `scripts/verify-phase10-wireback.mjs`, `scripts/eval-live-conversation.mjs`
