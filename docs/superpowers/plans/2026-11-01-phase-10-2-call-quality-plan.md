# Phase 10.2: qualidade da chamada

> **Spec:** `docs/superpowers/specs/2026-10-31-phase-10-live-call-engine-design.md` (§6.1–6.6, §7.9, §8.3, §11 linha 10.2).
> **Contrato:** `packages/shared/src/live-call-protocol.ts`, com as adições da 10.2 já escritas:
> - `hybrid`, `session.rotateAfterTurns`
> - `CallCommand.start.test`
> - os métodos `call:classifyAffect|reportStage|synthesize|startTest|getTestInput|reportTestResult` e `liveVoice:list|import|delete|preview`
> - os eventos `call:stage` e `call:testResult`
> - os tipos `CallStageSignal`, `CallSynthesizeResult`, `VoiceReference`, `CallTestResult` e `CallTestInput`
>
> **Base:** commit `066df0c`. O teste e2e real da 10.1 deu e2e de 1,2–1,6 s; o barge-in grava só o que foi ouvido.

## Escopo
1. **Barge-in completo:** ducking de −12 dB em `interrupt_pending`. O volume volta numa interrupção falsa. O AEC warm-up já existe.
2. **Repetição do modelo de 2B:**
   - **Rotação de sessão** a cada `rotateAfterTurns` turnos (padrão 6), quando o contexto estimado passar de 70%, ou **imediatamente** depois de detectar uma resposta quase repetida (similaridade ≥ 0,8 com alguma das últimas 6 respostas).
   - A sessão nova é semeada com um único `input_text` `[Contexto] Resumo da conversa até aqui: …`, montado a partir das últimas 4 trocas do ledger, com quase-duplicatas removidas.
3. **Emoção por camadas (§6.5):**
   - markers `<|ACT …|>` no texto, quando houver;
   - senão, `call:classifyAffect` por frase, uma heurística do host que é rápida e não usa LLM.
   - O sinal sai por `call:reportStage` **no momento em que o segmento começa a tocar**. O host emite `call:stage`, e o hub e o overlay aplicam a emoção e o movimento no avatar.
4. **Modo híbrido + voz de referência (§7.9, §8.3):**
   - a sessão realtime responde só em texto (`output_modalities:["text"]`);
   - o chunker com boost divide em frases;
   - `call:synthesize` → llama-server `/tts` com `speaker_ref_b64` da voz escolhida (ou só `voice`);
   - até `maxParallelTts` requisições, com playback em ordem.
   - Upload, normalização, lista, prévia e exclusão de vozes.
5. **Teste de chamada:**
   - `call:startTest`: o host sintetiza uma pergunta (voz masculina, `/tts`), reamostra para 16 kHz e inicia uma chamada com `test:true`.
   - O engine troca o microfone pelo WAV, faz um turno, reporta `CallTestResult` com as etapas (engine, session, vad, transcription, first_audio, playback) e as métricas, e encerra.
   - Turnos de teste **não** vão para a memória.
6. **Segurança do llama-server:**
   - `--api-key` aleatório a cada start;
   - o main injeta `Authorization: Bearer <key>` via `session.webRequest.onBeforeSendHeaders` **só** para a webContents da janela call-engine e só para `http(s)/ws://127.0.0.1:<porta do engine>/*`;
   - as chamadas do host (`/tts` etc.) usam `engine.getRequestHeaders()`;
   - a chave nunca vai ao renderer nem aparece em evento.

**Fora da 10.2:** Smart-Turn (BSD-2, mas precisa de features log-mel do Whisper e de validação em PT; fica para depois).

## Interfaces combinadas entre as tarefas (nomes exatos)
- **`CallEngineHost`** (`packages/voice/src/call/types.ts`, da T1) ganha:
  - `classifyAffect({callId, text}): Promise<CallStageSignal | null>`
  - `reportStage({callId, emotion, intensity, motion?}): Promise<unknown>`
  - `reportTestResult(input: CallReportTestResultInput): Promise<unknown>`
  - `synthesize({callId, text}): Promise<CallSynthesizeResult>` (usado pela sessão híbrida)
- **`CallEngineOptions`** ganha `testInput?: CallTestInput`. Quando presente, a captura vem do WAV em tempo real (blocos de 20 ms), seguido de 1,5 s de silêncio. Depois de um turno completo (ou de um timeout de 45 s), o engine chama `host.reportTestResult` e `stop('user_hangup')`.
- **Fábrica da sessão híbrida** (T2): `createLlamaCppHybridSession({ baseUrl, modelId, maxOutputTokens, synthesize: (text) => Promise<CallSynthesizeResult>, maxParallelTts, webSocketFactory? })`. Implementa `VoiceSession` + `submitUserText` e emite os mesmos eventos da sessão realtime (`response_text`, `response_audio {pcm, sampleRate}`, `response_done`). Para o engine, é transparente.
- **Engine llama.cpp** (T3): `getRequestHeaders(): Record<string,string>` e `getAuth(): { origin: string; port: number; headers: Record<string,string> } | null`, exposto ao main via `kernel.liveCall.getEngineAuth()`.

## Tarefas (paralelas)

### T1: qualidade no engine — `packages/voice/src/call/**` (exceto `llamacpp-hybrid-session.ts`), player em `packages/voice/src/voice-session-runtime.ts`
- **Ducking:** API `player.setDuck(db: number, rampMs: number)` no gapless player, com `setDuck(0)` para restaurar. É usada em `interrupt_pending` e no false-interrupt.
- **Rotação de sessão:**
  - gatilhos: contagem de turnos, estimativa de tokens (~4 chars/token) contra `contextSize` (vem de `CallRuntimeConfig.llamacpp.contextSize`; passar via opções), e repetição detectada;
  - fecha a sessão antiga sem fazer barulho, abre a nova com as mesmas instructions e envia o recap como **um** input_text antes do próximo turno;
  - `textSimilarity` própria (token Jaccard + contenção), sem importar do host.
- **Emoção:**
  - parser de `<|ACT {json}|>` e `}>` no texto da resposta, removido da legenda e do ledger;
  - por frase completa sem marker, `host.classifyAffect`;
  - mapear o offset de texto da frase para o tempo de áudio proporcional e agendar `host.reportStage` no instante em que esse trecho começa a tocar (relógio do player);
  - se o barge-in cortar a resposta, cancelar os sinais pendentes.
- **Modo de teste:** `testInput` (ver acima).
  - Etapas: `engine` (start ok), `session` (handshake), `vad` (speech_start + speech_end detectados), `transcription` (texto não vazio, com a similaridade com `expectedText` em `detail`), `first_audio` (ttfb), `playback` (fila esgotada).
  - `ok` = todas as etapas ok.
  - Em modo teste **não** chamar `recordTurn`.
- **Testes:** `packages/voice/test/voice-phase10-2-*.test.ts` cobrindo:
  - duck e restauração;
  - rotação por contagem, por repetição e por tokens, com o recap enviado antes do próximo turno e as instructions reenviadas;
  - ACT parseado e removido;
  - reportStage no tempo certo, e cancelado no barge-in;
  - modo teste reportando as etapas sem recordTurn.

### T2: híbrido, vozes, afeto e teste no host — `apps/desktop/src/host/live-call/{voices,synthesize,affect,test-call}.ts` (novos) + `handlers.ts`/`call-hub.ts`/`recorder.ts` (extensões), `packages/voice/src/call/llamacpp-hybrid-session.ts` (novo, + export em `call/index.ts`), `apps/desktop/src/call-engine/boot.ts`
- **`voices.ts`** (`liveVoice:list|import|delete|preview`):
  - armazenamento em `userData/voices/<id>.wav` + `voices.json` (escrita atômica);
  - o import valida o WAV (PCM16 mono, 16–48 kHz), com duração de 5–30 s e no máximo 20 vozes;
  - o id é um slug aleatório;
  - o preview chama `/tts` com `speaker_ref_b64` (ou sem, se `id` for null) e o texto padrão "Oi! Essa é a minha voz na chamada.", e devolve o WAV;
  - excluir a voz em uso volta `hybrid.referenceVoiceId` para null.
- **`synthesize.ts`** (`call:synthesize`):
  - POST `{baseUrl}/tts` com `{input, voice: settings.llamacpp.voice, language:'pt', response_format:'wav', speaker_ref_b64?}` e os headers `engine.getRequestHeaders?.() ?? {}`;
  - decodifica o WAV e devolve PCM16 base64, a taxa e a duração;
  - timeout de 20 s;
  - cache em memória do base64 da referência por id.
- **`affect.ts`** (`call:classifyAffect`, `call:reportStage`):
  - heurística PT por palavras-chave e pontuação, mapeando para `ASHY_EMOTIONS` e para os motions de `ASHY_MOTION_PRESETS` (em `@ashy/shared`); procurar heurísticas existentes no cortex/llm (affect, categorizer) e reaproveitá-las;
  - `reportStage` emite `call:stage`, aceito só do callId ativo.
- **`test-call.ts`** (`call:startTest`, `call:getTestInput`, `call:reportTestResult`):
  - o startTest garante que o engine está rodando e sintetiza "Oi Ashy, tudo bem? Me conta uma curiosidade rápida." com `voice:'male'`;
  - o resultado é reamostrado para WAV mono de 16 kHz e guardado por callId;
  - inicia a chamada pelo hub com `test:true`, o que gera `call:command start {test:true}`;
  - `reportTestResult` emite `call:testResult`;
  - o recorder **ignora** turnos de chamadas de teste.
- **`call-hub.ts`:** aceitar `llamacpp-hybrid` (os mesmos requisitos de engine) e propagar `test`.
- **`llamacpp-hybrid-session.ts`:** conforme a interface acima.
  - Usar o chunker existente (`createTtsChunker`/markdown segmenter, com boost) sobre os deltas de texto.
  - Paralelismo limitado, com saída ordenada.
  - `cancelResponse` cancela a sessão, descarta os TTS pendentes e ignora os que chegarem depois.
  - O watchdog vale só para texto degenerado.
- **`boot.ts`:**
  - escolher a sessão por `config.backend` (`llamacpp-realtime` ou `llamacpp-hybrid`, este com `synthesize` → `call:synthesize`);
  - em `command.test`, buscar `call:getTestInput` e passar `testInput`;
  - implementar no adapter de host os novos métodos de `CallEngineHost`.
- **Testes:**
  - `apps/desktop/src/__tests__/phase-10-2-*.test.ts`: vozes (validação, limites, exclusão da voz ativa), synthesize (headers, ref, decode), afeto, fluxo de teste (sem gravação na memória);
  - `packages/voice/test/voice-phase10-2-hybrid-session.test.ts`: ordem com TTS fora de ordem, cancelamento, eventos.

### T3: segurança + UI — `apps/desktop/src/host/engines/llamacpp-engine.ts` (api key), `apps/desktop/src/main/index.ts` (injeção de header), `kernel.ts` (`getEngineAuth`, uma linha), `apps/desktop/src/components/LiveCallControls.tsx`, `apps/desktop/src/store/useCallStore.ts`, `App.tsx` (se precisar), `styles.css`
- **Engine:**
  - chave aleatória de 32 bytes em hex por start, passada como `--api-key` via env `LLAMA_API_KEY` (não na linha de comando, que fica visível no Gerenciador de Tarefas);
  - health em `/health` (público);
  - `getRequestHeaders()` e `getAuth()`;
  - endpoint próprio do usuário fica sem chave.
- **Main:**
  - `webRequest.onBeforeSendHeaders` no session da janela call-engine, com filtro de URL da porta atual;
  - injeta o header só quando `details.webContentsId` é o da call window;
  - atualiza a cada `engine:status` que mude porta ou estado.
  - Validar que o upgrade do WebSocket passa pelo `webRequest`. Se não passar, documentar e usar como fallback a query `?api_key=` só se o llama-server suportar. Verificar no código-fonte do llama.cpp b12024 (`tools/server`), sem adivinhar.
- **UI (Configurações › Live Mode):**
  - card "Local omni + minha voz (híbrido)" habilitado;
  - seção **Voz de referência** (só aparece quando o backend é híbrido):
    - upload de arquivo (wav, mp3, flac, ogg, m4a);
    - normalização no renderer com `AudioContext.decodeAudioData`, depois `OfflineAudioContext` para mono 24 kHz, corte de silêncio nas pontas, limite de 30 s, e encode PCM16 WAV;
    - lista com ouvir (`liveVoice:preview`), excluir e "usar esta voz";
    - aviso: "Use só vozes que você tem direito de usar.";
  - "Rotação de sessão" (número de turnos);
  - botão **Testar chamada**, com resultado por etapa (✓/✗, ms) e métricas, ouvindo `call:testResult`.
- **Stage:** `useCallStore` assina `call:stage` e, durante a chamada, aplica `stageEmotion`, `emotionIntensity` e `activeMotion` (via `resolveMotionPreset`) no `useAshyStore`.
- **Testes:** `apps/desktop/src/__tests__/phase-10-2-call-ui-security.test.tsx`, cobrindo:
  - api key no env do spawn e nunca no status;
  - `getRequestHeaders`;
  - filtro do `webRequest` (call window sim, outra janela não, outra porta não);
  - UI: upload normalizado (OfflineAudioContext fake), lista, prévia, uso da voz, teste de chamada exibindo o resultado, e `call:stage` mudando a emoção do stage.

## Integração
1. `pnpm typecheck`, `pnpm test` e `pnpm build`.
2. Rodar o e2e real da 10.1 de novo (`scratchpad/e2e-call.ts`, que precisa passar o header da api key no WS em Node: usar `getEngineAuth`).
3. E2e do modo híbrido com uma voz de referência (amostra gerada pelo `/tts` masculino).
4. E2e do modo teste.
5. Commit + push. O Carlos faz `git pull` + install.
