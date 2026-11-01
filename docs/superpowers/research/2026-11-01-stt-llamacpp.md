# STT das chamadas pelo llama-server (sem segunda cópia do LFM3-Omni no Ollama)

- **Data:** 2026-11-01
- **Escopo:** `call:transcribe` nos backends `llamacpp-realtime`, `llamacpp-hybrid` e `cascade`
- **Status:** implementado (`apps/desktop/src/host/live-call/llama-stt.ts`) + medido com áudio real no llama-server gerenciado (b12024, CUDA 12.4, LFM3-Omni-2B Q4_K_M + mmproj Q8_0) e no Ollama (`hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M`)

## 1. Problema

Com os backends locais, a fala do usuário ia para o Ollama (`ollama-transcriptions` →
`POST /v1/audio/transcriptions` com LFM3-Omni) enquanto o llama-server gerenciado do Ashy já tinha
o mesmo modelo carregado. Numa GPU de 8 GB isso são duas cópias (≈1,4 GB no Ollama + ≈2,5 GB no
llama-server), o que estourou a VRAM e travou o Ollama.

## 2. Rotas avaliadas (llama.cpp b12024)

| Rota | Como | Observação |
|---|---|---|
| (a) `rt` | `GET /v1/realtime?intent=transcription` (WS), `session.update {type:'transcription', audio.input.transcription.language:'pt'}`, `input_audio_buffer.append` PCM16 à taxa do modelo (16 kHz, de `session.created`), `commit`, ler `conversation.item.input_audio_transcription.completed` | o servidor usa o prompt ASR do template do modelo (`common_chat_get_asr_prompt`); 1 conexão WS por fala |
| (b) `chat` | `POST /v1/chat/completions`, system `"Perform ASR in Portuguese."`, user `[{type:'input_audio', input_audio:{data:<wav b64>, format:'wav'}}]`, `temperature:0` | depende da nossa instrução |
| (c) `oai` | `POST /v1/audio/transcriptions` do **próprio llama-server** (multipart `file`, `language=pt`) | existe na b12024 (`routes.post_transcriptions_oai`); mesmo contrato do caminho Ollama |
| `ollama` | caminho atual (`ollama-transcriptions`) | referência |

Todas as requisições ao llama-server levam `engine.getRequestHeaders()` (sem a chave → HTTP 401
`Invalid API Key`, confirmado).

## 3. Medição (2026-11-01, RTX 8 GB compartilhada com o Ashy do usuário + Ollama já carregados)

Amostras: 12 frases pt-BR sintetizadas pelo `/tts` do engine (vozes `female`/`male`, curtas e longas)
+ `spike-question.wav` (texto conhecido) + `q2.wav` (sem referência). Uma chamada de aquecimento por
rota, não medida. WER/CER sobre texto normalizado (minúsculas, sem pontuação).

| Rota | WER médio | CER médio | exatas | latência média | p50 | máx | erros |
|---|---|---|---|---|---|---|---|
| (a) realtime transcription | 0,129 | 0,083 | 9/13 | 404 ms | 461 ms | 735 ms | 0 |
| (b) chat + `input_audio` | 0,129 | 0,083 | 9/13 | 238 ms | 260 ms | 334 ms | 0 |
| **(c) `/v1/audio/transcriptions` (llama-server)** | **0,129** | **0,083** | **9/13** | **223 ms** | **256 ms** | **328 ms** | **0** |
| Ollama `ollama-transcriptions` | 0,136 | 0,084 | 9/13 | 178 ms | 209 ms | 267 ms | 0 |

Por amostra (latência em ms: rt | chat | oai | ollama):

| Amostra | áudio | rt | chat | oai | ollama | texto (a/b/c, idêntico nas três) | texto Ollama |
|---|---|---|---|---|---|---|---|
| "Oi." (f) | 800 ms | 175 | 242 | 133 | 138 | Oi. | Oi. |
| "Pode." (m) | 960 ms | 183 | 218 | 147 | 106 | Pode. | Pode. |
| "Pode sim." (f) | 1120 ms | 214 | 188 | 157 | 113 | Cody Sim. | Cody Sim. |
| "Não, obrigado." (m) | 1280 ms | 646 | 172 | 172 | 134 | Não, obrigado. | Não. Obrigado. |
| "Tudo bem com você?" (f) | 1120 ms | 223 | 171 | 166 | 126 | Tudo bem com você? | idem |
| previsão do tempo SP (m) | 2880 ms | 435 | 271 | 264 | 213 | exato | exato |
| lembrete mãe 20h (f) | 3520 ms | 532 | 294 | 286 | 221 | "…para minha mãe…" (falta "a") | idem |
| problema no servidor (m) | 3040 ms | 477 | 260 | 256 | 209 | exato | exato |
| bolo de cenoura (f) | 4480 ms | 608 | 334 | 324 | 267 | exato | exato |
| resumir a conversa (m) | 3200 ms | 461 | 275 | 277 | 229 | exato (sem "?") | exato |
| "Pode." (f) | 880 ms | 191 | 150 | 152 | 132 | Paudi. | Paudi. |
| "Oi." (m) | 640 ms | 164 | 113 | 138 | 129 | Oi. | Oi. |
| spike-question | 4000 ms | 735 | 319 | 328 | 220 | Oi, Achi. Tudo bem. Me fala… | Oyashi, tudo bem. Me fala… |
| q2 (sem ref.) | 4640 ms | 612 | 330 | 328 | 253 | Ashie, me conta como foi o seu dia hoje… | idem |

Leitura:

- As três rotas do llama-server devolvem **o mesmo texto** em todas as amostras (mesmo prompt ASR do
  modelo); a qualidade é a do Ollama (mesmo modelo/quantização). Os erros ("Cody Sim.", "Paudi.")
  aparecem em todas as rotas e vêm do áudio sintetizado, não da rota.
- (a) é a mais lenta (~+180 ms: handshake WS + `session.update` por fala). (b) e (c) empatam; (c) não
  depende de uma instrução nossa.
- O Ollama ficou ~45 ms mais rápido nesta medição, mas é o caminho que mantém a segunda cópia do
  modelo na VRAM — o custo que motivou a mudança.
- Concorrência (cenário `llamacpp-realtime`): com uma sessão `/v1/realtime` de conversa aberta e
  ociosa, (c) levou 697 ms; com essa sessão **gerando** resposta (texto + áudio), 2,2–2,3 s, ainda
  correto e dentro do limite de 6 s. Na chamada a transcrição normalmente ocorre depois que a Ashy
  parou de falar.

## 4. Escolha e implementação

**Rota (c)**, `POST {llama-server}/v1/audio/transcriptions`, roteada internamente (sem novo id de STT
no contrato nem no seletor de STT da cascata):

- `call:transcribe` tenta o llama-server primeiro quando: backend ∈ {`llamacpp-realtime`,
  `llamacpp-hybrid`, `cascade`}; o STT efetivo é o caminho Ollama/LFM3 (`ollama-transcriptions` ou
  `web-speech-stt`; na cascata vale `settings.cascade.sttProviderId`, nos demais o STT ativo das
  configurações de voz) — uma escolha explícita de Whisper/Groq/OpenAI é respeitada; o engine está
  `running` com `baseUrl` (gerenciado, ou endpoint do usuário depois do health check); e o modelo
  ativo tem `capabilities.audioIn`.
- Limite de 6 s (`LLAMA_STT_TIMEOUT_MS`); qualquer falha (transporte, HTTP, timeout, resposta sem
  `text`, resposta em estilo de chat pela mesma heurística do Ollama, agora em `host/stt-chat-style.ts`)
  gera um aviso e cai no STT configurado (kernel `transcribeVoiceAudio`).
- A guarda de < 300 ms continua antes de qualquer rota. `providerId` reportado:
  `llamacpp-transcriptions`.
- Testes: `apps/desktop/src/__tests__/phase-10-5-call-stt-llamacpp.test.ts` (escolha de rota,
  fallback em erro/timeout/estilo de chat, guarda de 300 ms, cabeçalhos de autenticação, escolha
  explícita de STT respeitada). Verificação real do módulo do host contra o engine gerenciado: textos
  iguais aos da tabela, 160–340 ms; chave errada → 401 → fallback.
