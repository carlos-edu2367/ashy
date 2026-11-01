# Phase 10.4 — Cloud speech-to-speech backends (OpenAI Realtime, Qwen-Omni, Gemini Live)

Date: 2026-11-01. No cloud API key exists on the dev machine: everything below was implemented from the
providers' current official docs and proven with scripted fake servers. Nothing was sent to any service.

## 1. Verified protocol facts (with sources)

### OpenAI Realtime (GA)
- Endpoint `wss://api.openai.com/v1/realtime?model=<id>`, header `Authorization: Bearer <key>`. The GA
  interface needs **no** `OpenAI-Beta: realtime=v1` header (only third-party mirrors still show it).
  <https://developers.openai.com/api/docs/guides/realtime-websocket>
- Current models: `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` (128k context, function calling,
  realtime only). Preset default changed `gpt-realtime-mini` → **`gpt-realtime-2.1-mini`**.
  <https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini>
- `session.update {session:{type:'realtime', instructions, output_modalities:['audio'] (audio OR text, never
  both), audio:{input:{format:{type:'audio/pcm', rate:24000}, transcription:{model, language},
  turn_detection}, output:{format, voice}}, tools, tool_choice, max_output_tokens}}`. Input PCM is 24 kHz only.
  Transcription models include `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `gpt-realtime-whisper`, …
  <https://developers.openai.com/api/reference/resources/realtime/client-events>
- Turn detection `server_vad` (threshold, prefix_padding_ms, silence_duration_ms, idle_timeout_ms) or
  `semantic_vad` (eagerness low/medium/high/auto); `create_response` (default true) and
  `interrupt_response` (default true). <https://developers.openai.com/api/docs/guides/realtime-vad>
- `response.create.response.instructions` overrides the session instructions **for that response only**
  (also `tool_choice`, `output_modalities`, `conversation:'none'`, `input`).
- `conversation.item.truncate {item_id, content_index:0, audio_end_ms}` (assistant items only; beyond the
  real audio length = error; also drops the transcript after that point).
- Voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse, **marin**, **cedar** (recommended); voice
  cannot change after the model spoke. Image input: `input_image` part with a data URL. Max session 60 min.
  <https://developers.openai.com/api/docs/guides/realtime-conversations>
- Server events used: `session.created/updated`, `input_audio_buffer.speech_started|speech_stopped|committed`,
  `conversation.item.input_audio_transcription.delta|completed|failed`, `response.created`,
  `response.output_item.added`, `response.output_audio.delta`, `response.output_audio_transcript.delta`,
  `response.function_call_arguments.done`, `response.done` (complete function calls in `output`), `error`.

### Qwen-Omni realtime (Alibaba Model Studio / DashScope)
- OpenAI-Realtime-*like* but **not** GA-compatible: beta-style flat session and event names.
  Endpoint `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=<id>` (Singapore; Beijing:
  `dashscope.aliyuncs.com`), `Authorization: Bearer <DashScope key>`; keys are per region. Newer pages also
  list workspace endpoints `wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime`
  (qwen3.8-omni-flash-realtime, qwen3.5-omni-plus/flash-realtime).
  <https://www.alibabacloud.com/help/en/model-studio/realtime>,
  <https://www.alibabacloud.com/help/en/model-studio/omni-realtime-interaction-process>
- Models: `qwen3.8-omni-flash-realtime` (newest), `qwen3.5-omni-plus-realtime`,
  `qwen3.5-omni-flash-realtime`, `qwen3-omni-flash-realtime-2025-09-15`. Preset default changed
  `qwen3-omni-flash-realtime`/`Cherry` → **`qwen3.5-omni-flash-realtime`/`Tina`** (Tina = default voice of
  the 3.5 series; Cherry is the 2025-09-15 default).
- `session.update` fields: `modalities` (`['text','audio']`), `voice`, `input_audio_format:'pcm'` (16 kHz
  mono only), `output_audio_format:'pcm'` (24 kHz), `instructions`, `turn_detection {type:'server_vad'|
  'semantic_vad', threshold, silence_duration_ms, idle_timeout_ms}` or `null` (manual), `tools` as
  `{type:'function', function:{name, description, parameters}}`, sampling params.
  `input_audio_transcription:{model:'qwen3-asr-flash-realtime'}` appears in the guide examples.
  <https://www.alibabacloud.com/help/pt-br/model-studio/client-events>
- No `create_response`: in VAD mode the server answers by itself. `response.create` has no fields.
  `conversation.item.create` accepts **only** `function_call_output`. No `conversation.item.truncate`.
  Images: `input_image_buffer.append {image}` (JPEG ≤ 256 KB, after at least one audio append).
- Server events: `response.audio.delta`, `response.audio_transcript.delta`, `response.text.delta`,
  `conversation.item.input_audio_transcription.completed`, `input_audio_buffer.speech_started|stopped|
  committed`, `response.function_call_arguments.done`, `response.done`. Session ≤ 120 min.

### Gemini Live API
- Endpoint `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<key>`.
  Only the `key` query param (or ephemeral tokens via `BidiGenerateContentConstrained?access_token=`) is
  documented; no source documents `x-goog-api-key` for the WebSocket.
  <https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket>
- Models: **`gemini-3.8-live`** (default, native audio), `gemini-3.8-live-extended-thinking`, legacy
  Gemini 3.1 Flash Live Preview. Preset default changed `gemini-live-2.5-flash-preview` → `gemini-3.8-live`.
  Native-audio models choose the language themselves and **don't support `languageCode`**: pt-BR is asked
  for in the system instruction. Voice via `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` (Kore…).
  <https://ai.google.dev/gemini-api/docs/live-api/capabilities>
- Setup fields: `model`, `generationConfig{responseModalities, speechConfig}`, `systemInstruction`,
  `tools`, `realtimeInputConfig{automaticActivityDetection{disabled, start/endOfSpeechSensitivity,
  prefixPaddingMs, silenceDurationMs}, activityHandling}`, `inputAudioTranscription`,
  `outputAudioTranscription`, `contextWindowCompression{slidingWindow, triggerTokens}`,
  `sessionResumption{handle}`. Wait `setupComplete` before sending anything else.
  <https://ai.google.dev/api/live>
- `realtimeInput.audio {data, mimeType:'audio/pcm;rate=16000'}` (raw PCM16 LE 16 kHz); `audioStreamEnd` when
  the mic pauses; output audio 24 kHz. `serverContent.interrupted` = server VAD barge-in (history keeps only
  what was sent). `clientContent` is allowed all session long but interrupts an ongoing generation.
- 3.8 Live function calling is async by default; `behavior:'BLOCKING'` keeps the classic wait-for-result
  (not supported on extended-thinking → NON_BLOCKING + `scheduling`).
- Without compression: audio sessions 15 min; a connection lives ~10 min → `goAway{timeLeft}`;
  `sessionResumptionUpdate{newHandle, resumable}` handles valid 2 h.
  <https://ai.google.dev/gemini-api/docs/live-api/session-management>

### Electron
- Chromium's webRequest: "Redirects from URLs with ws:// and wss:// schemes are ignored" (chrome.webRequest
  `redirectUrl`, added with WebSocket support in webRequest, crbug review 2449913002). So the planned
  `onBeforeRequest` redirect to append `?key=` cannot work for Gemini.

## 2. Decisions

- **Loopback relay for every cloud provider** (`apps/desktop/src/host/live-call/cloud-relay.ts`). The call
  window opens `ws://127.0.0.1:<port>/cloud/<callId>`; Electron main injects a per-run relay token header
  only into the call window's ws requests to that port (same `installScopedRequestHeaders` router as the
  llama-server key); the relay resolves the active call's upstream (URL + `Authorization: Bearer` or
  `?key=`, decided host-side from settings) and pipes JSON messages (Gemini's binary frames → text).
  Keys never reach the renderer, `custom` URLs need no CSP wildcard (`ws://127.0.0.1:*` was already
  allowed), so **the CSP was not changed**. Upstream handshake errors become close codes `4000+HTTP status`
  (4401 bad key, 4429 quota), 4001 no key, 4002 unreachable, 4003 not the active call; reasons are
  redacted.
- OpenAI: `semantic_vad` + `create_response:false` + `interrupt_response:true` → the engine waits for the
  user transcript (≤ 1.5 s), builds THIS turn's context (memories via `call:buildContext`) and sends it in
  `response.create.response.instructions` (`caps.contextInjection:'instructions'`, nothing accumulates).
  Barge-in → `response.cancel` + `conversation.item.truncate` at the played ms.
- Qwen and Gemini answer by themselves (`caps.serverAutoResponse`): the context is injected one turn
  lagged — Qwen via `session.update {instructions: base + context}`, Gemini via `clientContent
  {turnComplete:false}` sent only while the model is idle.
- The engine never rotates server-managed sessions (`caps.managesContext`); tools run inside spoken
  responses (`caps.inlineToolCalls`, ≤ 3 rounds, chained calls allowed).
- Missing key → `call:start` ends `backend_unavailable` with a PT detail ("Chave de API do … não
  configurada"); no new end reason was needed.
- Cloud instructions: the chat soul prompt (minus stage-marker/MCP/chat-format sections and any `<|…|>`
  line — a speech model would say them aloud) + user name + last 12 messages of the shared chat + a PT call
  mode block (+ tools block). Optional `settings.cloudContext` knobs are read if present.

## 3. What the fakes prove (tests)

- `packages/voice/test/voice-phase10-4-cloud-sessions.test.ts` (21): OpenAI GA handshake/session.update,
  appends, VAD/transcription mapping, per-response instructions, cancel + truncate (clamped), server
  interruption, tool round trip, system item / image, error fatality, relay close codes; Qwen flat session,
  auto responses with beta names, instructions-based context, no truncate, image rule; Gemini setup,
  BLOCKING/NON_BLOCKING, binary frames, transcripts, interrupted, toolCall/toolResponse, idle-only
  clientContent, GoAway resumption, missing-key setup failure; the cloud session factory.
- `packages/voice/test/voice-phase10-4-call-engine-cloud.test.ts` (10): full OpenAI turn (mic streamed,
  server VAD, backend transcript → context → response → recordTurn, no host STT), late transcript fallback,
  barge-in with truncate at the played ms, tool round trip inside a spoken turn, no rotation, mute → clear;
  Gemini: local VAD UI + server answer + lagged clientContent + recordTurn, `interrupted` barge-in,
  adoption of an unannounced server response, response timeout.
- `apps/desktop/src/__tests__/phase-10-4-cloud-backends.test.ts` (12): WS framing; the REAL relay over
  loopback sockets with a fake upstream (Bearer/`?key=` added host-side, token required, binary→text,
  4401 + redaction, 4002, 4003 after hang-up); encrypted key store (no plaintext on disk, masked status);
  target resolution; cloud instructions; `call:start` without key → `backend_unavailable`, with key →
  relay runtime config, key absent from every event/config/status; main header scope (call window + relay
  port + ws only).

## 4. Needs a real key to validate

Actual model ids/voices accepted, the real `session.created/updated` payloads, transcription timing (the
1.5 s wait), Gemini binary frames/`setupComplete` shape, the Gemini `BLOCKING` behaviour on 3.8 Live,
DashScope endpoint per region/model, audio quality of the 16→24 kHz linear resampling, and the relay over
TLS (`wss://` via `node:https`; it does not use the system proxy).

## 5. Morning checklist (per provider)

Prerequisite: the UI wiring (see the Phase 10.4 report — boot.ts factory + settings fields) is merged.

1. **OpenAI**: Settings › Modo ao vivo › backend "OpenAI Realtime", provider `openai` (model
   `gpt-realtime-2.1-mini`, voice `marin`). Paste the key (`liveMode:setApiKey {provider:'openai'}`; the chat
   OpenAI key is used as fallback). Start a call, say "qual é o meu nome?" — expect the reply in ~1 s, a
   user caption from the server transcript, and the turn in the chat history. Interrupt mid-answer: it
   must stop and the history must hold only the heard part. With `features.toolsInCall`, ask "qual janela
   eu estou usando?".
2. **Qwen**: provider `qwen`, key from Model Studio **Singapore** (intl endpoint). If the handshake closes
   4404/4401, set the URL to your workspace endpoint
   `wss://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime` (or Beijing + a Beijing key)
   and/or model `qwen3.8-omni-flash-realtime`.
3. **Gemini**: backend "Gemini Live", model `gemini-3.8-live`, voice `Kore`, key from AI Studio
   (`provider:'gemini'`). Check the reply is in pt-BR, barge-in stops audio, a ≥ 12-min call survives the
   GoAway resumption, and a tool request works (if 3.8 rejects `behavior:'BLOCKING'`, remove it in
   `buildGeminiFunctionDeclarations`).
4. **Custom** (e.g. a local OpenAI-Realtime-compatible omni server): provider `custom`, URL + model; a key
   is optional. The settings schema currently only accepts `wss://` — see the report for the needed
   `ws://127.0.0.1|localhost` allowance.
5. Failure messages to expect in the call caption/detail: "chave de API inválida (HTTP 401)", "limite de
   uso/cota excedido (HTTP 429)", "Chave de API do … não configurada".
