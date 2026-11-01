# Phase 10.5 — Pipeline clássica (cascata) do Live Mode: STT → LLM de texto → TTS em chunks

- **Data:** 2026-11-01
- **Escopo:** backend `cascade` do Live Mode (spec `2026-10-31-phase-10-live-call-engine-design.md` §5.3, §6, §8.5)
- **Status:** implementado + validado com execuções reais locais (kernel real, CallEngine real, Ollama STT real, LLM pequeno real, llama.cpp `/tts` real)

## 1. Desenho

```
mic → CallEngine (VAD → WAV) → call:transcribe (settings.cascade.sttProviderId)
    → call:buildContext (memórias, hora, humor, aprovação por voz, tela, interrupção, política de tools)
    → CascadeSession.submitTranscribedTurn({text, context, toolChoice})
    → host call:cascadeTurn {callId, turnId, text, context, toolChoice}
         → TurnOrchestrator.runVoiceCallTurn (persona Ashy, histórico da sessão, recuperação de memória,
           loop de tools pelo gatekeeper, diretiva de voz, provider/modelo da cascata)
         → eventos `call:cascade` {delta|tool|done|error|aborted} só para a janela da chamada
    → chunker com boost → call:synthesize (roteado por settings.cascade.ttsProviderId)
         llama.cpp /tts (+ voz de referência) | local-kokoro-http | openai-tts | elevenlabs
    → síntese em paralelo limitada (maxParallelTts), áudio emitido estritamente na ordem das frases
    → playback / ledger do engine → call:recordTurn (só o que foi ouvido, modality 'voice')
```

Decisões (e por quê):

| Decisão | Motivo |
|---|---|
| **Reusar o orquestrador** (`runVoiceCallTurn`) em vez de um LLM próprio na sessão | A cascata herda persona, histórico sanitizado, memória, provider vault (chaves), adaptador Ollama nativo com sampling e o loop de tools — nada reimplementado. |
| **Geração sem persistência no orquestrador; persistência só pelo `call:recordTurn`** | Um único caminho de persistência: o recorder já grava modality `voice`, flag `interrupted`, texto realmente falado, afeto e pipeline de memória. Nunca há linha duplicada (teste: 1 `recordTurn` por turno; orquestrador não chama `appendChatMessage`). |
| **Eventos próprios `call:cascade`** (não `turn:delta`) | O store da janela principal ignora eventos Live Call; `turn:*` faria a janela de chat renderizar/falar o turno de novo. |
| **`turnId` gerado pelo cliente** | Nenhum delta chega antes da sessão conhecer o id. |
| **Texto da resposta = só frases cujo áudio foi emitido** | O LLM corre à frente do áudio; o ledger fatia o texto proporcionalmente ao áudio. Com o texto "em sincronia com o áudio", o barge-in grava só o que foi ouvido e uma frase cujo TTS falhou nunca conta como dita. (Mesmo problema existe no hybrid 10.2 — fora do escopo, registrado.) |
| **Tools dentro do turno do host, só com `toolChoice:'auto'`** | A política de intenção da 10.3 (`decideToolChoice`) evita que modelos pequenos chamem tools em conversa fiada. São as 4 tools enxutas da chamada, executadas por `executeCallTool` com `origin.callId` → aprovação por voz ("pode") funciona igual à 10.3. `caps.toolCalls=false`: o fluxo de tool step em 2 etapas do engine não é usado. |
| **`caps.managesContext=true`** | O histórico vive no banco (linhas de voz); o engine nunca rotaciona/recapitula uma sessão de cascata. |
| **`submitTranscribedTurn` (novo, opcional em `VoiceSession`)** | O engine entrega texto cru + contexto + política de tools em vez de um `input_text` formatado. |
| **Prompt compacto para Ollama** | Sistema = identidade + nome + diretiva de voz + bloco "bastidores" (memórias, hora, aprovação, tela); turno do usuário = **só as palavras**. Na execução real, contexto no turno do usuário fez o LFM3 escrever "[Resumo] …"/"[Contexto] …" e confundir papéis. |
| **Guarda de stream de voz** | Remove rótulo inicial ("Ashy:"), emojis, e **corta** a geração no primeiro "[Resumo]/[Contexto]/…" ou novo turno ("\nUsuário:"). |
| **Nota de ação pendente** | Enquanto houver ação desta chamada aguardando aprovação, o host injeta "AINDA NÃO feita… só com 'pode'". O qwen3-4b respondeu "Opa, anotado" a um "Partisim, por favor" (ASR) não reconhecido como aprovação. |
| **`prepare` no connect (llama.cpp /tts)** | Liga o llama-server gerenciado e aquece o vocoder antes da primeira resposta; falha → `backend_unavailable` com detalhe claro (ex.: `TTS_UNAVAILABLE: llama.cpp is not installed`, observado de verdade). |

## 2. Arquivos

- `packages/voice/src/call/cascade-session.ts` — `createCascadeSession` (VoiceSession + `submitTranscribedTurn`).
- `packages/voice/src/call/types.ts` — `VoiceSession.submitTranscribedTurn?`, `VoiceTranscribedTurn`.
- `packages/voice/src/call/call-engine.ts` — no `commitTurn` transcrito, prefere `submitTranscribedTurn` (≈15 linhas).
- `apps/desktop/src/host/turn-orchestrator.ts` — `runVoiceCallTurn` (+ `onAborted` na entrada ativa).
- `apps/desktop/src/host/voice-call-prompt.ts` — diretiva de voz, prompt compacto/completo, guarda de stream.
- `apps/desktop/src/host/live-call/cascade.ts` — `call:cascadeTurn`, `call:cascadeAbort`, roteador de TTS, tools da cascata.
- `apps/desktop/src/host/live-call/handlers.ts` — registra a cascata; `call:synthesize` roteia chamadas `cascade`; `call:transcribe` usa `cascade.sttProviderId`; `call:recordTurn` grava o modelo da cascata.
- `apps/desktop/src/host/live-call/transcribe.ts` — `providerId` opcional.
- `apps/desktop/src/host/live-call/approvals.ts` — "podi" → "pode" (grafia do ASR vista na execução real).
- `apps/desktop/src/host/kernel.ts` — 2 deps: `getTurnOrchestrator`, `synthesizeSpeech`.
- `apps/desktop/src/call-engine/cascade.ts` — `createCascadeSessionOverBridge` / `createCascadeCallEngine` (glue da janela).
- `packages/shared/src/live-call-protocol.ts` — métodos `call:cascadeTurn|call:cascadeAbort`, schemas, evento `call:cascade`.
- Testes: `packages/voice/test/voice-phase10-5-cascade-session.test.ts`, `apps/desktop/src/__tests__/phase-10-5-cascade-host.test.ts`.

## 3. Execuções reais (2026-11-01, RTX 4060 8 GB)

Montagem: kernel real em userData de rascunho (DB vazio, junctions para o llama.cpp gerenciado), CallEngine real
(VAD `hybrid-dsp` — o Silero ONNX não carrega no node), microfone falso alimentado em tempo real com perguntas
sintetizadas pelo `/tts` (voz masculina), relógio de playback em tempo real, STT `ollama-transcriptions` (LFM3-Omni
no Ollama), TTS `llamacpp-tts` (llama-server gerenciado, voz feminina), 8–9 turnos: saudação com nome, curiosidade,
pergunta longa + **barge-in** ("Espera, espera. Resume em uma frase só."), pedido de **nota** (tool + aprovação por
voz), **recordação** ("lembra meu nome e do que eu gosto?"), dois turnos de variedade (nome de gato preto/laranja).

**Atenção ao ambiente:** durante todas as execuções outros agentes rodavam evals com até 3 llama-servers extras na
mesma GPU (utilização 60–100 %, VRAM 7–7,8 GB/8). Os números de TTS e do qwen (parcialmente fora da VRAM) estão
inflados por isso; o LLM LFM3 (o mesmo modelo já carregado para STT) foi o menos afetado.

| Modelo de texto (Ollama) | 1º token LLM (mediana) | ASR (mediana) | TTS por frase (mediana) | fim da fala → 1º áudio (mediana) |
|---|---|---|---|---|
| LFM3-Omni-2B Q4_K_M (prompt final) | **0,40 s** | 0,56 s | 4,6 s (contenção) | **5,5 s** |
| qwen3:4b-instruct Q4_K_M (prompt final) | 4,0 s (contenção/offload) | 1,55 s | 6,3 s | 16,0 s |
| qwen3:4b-instruct (1ª rodada, GPU com 5 llama-servers) | 4,8 s | 1,2 s | 14,4 s | 26,5 s |
| qwen3.5:4b (sonda isolada) | — | — | — | 2,4 tok/s: não coube com o resto na VRAM, descartado |

Sonda isolada (GPU sem os evals): qwen3:4b-instruct gerou a 69,8 tok/s com prompt eval de 156 ms — sem
contenção, o 1º token esperado do qwen é ~0,3 s e a latência fim-da-fala→áudio fica dominada pelo ASR (~0,5 s) +
1ª frase do `/tts`.

Qualidade observada:

- **qwen3:4b-instruct (recomendado como "modelo pequeno de texto")**: respostas curtas, relevantes e variadas
  ("Tio Preto? Ou talvez Nebula…", "Laranja? Então é o Sol!"), lembrou "Carlos, e você adora astronomia!",
  **chamou `write_project_note`**, a ação ficou pendente (`voiceApprovable`) e ela pediu a aprovação
  ("Pode aprovar a nota "Comprar leite"?"). Falhas: o ASR transcreveu a aprovação como "Partisim, por favor"
  (não aprovou — correto) e o modelo disse "anotado" mesmo assim → corrigido com a nota de ação pendente.
- **LFM3-Omni-2B como LLM de texto**: muito rápido, PT ok, barge-in e "Resume em uma frase só" corretos, lembrou o
  nome. Fraquezas do 2B: confusão de papéis ocasional ("Meu nome é Carlos e eu adoro astronomia"), **não chama tools**
  (alucinou "Comprei: leite"), e — antes da correção do prompt — escrevia notas "[Resumo] …" que iam para a fala e
  para o histórico (envenenando os turnos seguintes). Com o prompt final + guarda de stream isso sumiu.
- **Barge-in**: corta LLM e TTS; o registro interrompido é verdadeiro ("Um buraco negro começa quando uma estrela",
  `interrupted: true`), e o turno seguinte recebe a nota de interrupção.
- **Persistência**: 2 linhas `voice` por turno, sem duplicatas; o turno interrompido fica com o trecho falado.

Logs: scratchpad da sessão (`cascade-run-*.log`).

## 4. Como configurar

`liveMode:saveSettings`:

```json
{
  "backend": "cascade",
  "cascade": {
    "sttProviderId": "ollama-transcriptions",
    "llmProviderId": "ollama",
    "llmModelId": "qwen3:4b-instruct",
    "ttsProviderId": "llamacpp-tts",
    "ttsVoice": "female",
    "referenceVoiceId": null
  }
}
```

- `llmProviderId: "chat-default"` usa o provider/modelo ativo do chat (cloud: prompt completo da Ashy + diretiva).
  Qualquer id de `LLM_PROVIDER_IDS` (openrouter, anthropic, openai, nvidia-nim, ollama) + `llmModelId` opcional.
- Com Ollama como provider do chat em LFM3 (STT) e a cascata em `qwen3:4b-instruct`, o Ollama mantém os dois.
  `ollama pull qwen3:4b-instruct` (2,5 GB).
- `ttsProviderId`: `llamacpp-tts` (llama-server gerenciado/endpoint; `ttsVoice` female/male; `referenceVoiceId`
  clona a voz), `local-kokoro-http` / `openai-tts` / `elevenlabs` (usam URL/chave/voz das configurações de voz;
  `ttsVoice` diferente de female/male vira o `voiceId`).
- `sttProviderId`: qualquer `STT_PROVIDER_IDS` (`ollama-transcriptions`, `local-whisper-http`, `openai-whisper`,
  `groq-whisper`).

## 5. Pendências / próximos passos

- Wiring na janela da chamada (`boot.ts`) e UI (`LiveCallControls`): ver relatório do agente (não editados aqui).
- Silero no node para a harness (VAD `hybrid-dsp` às vezes perde frases muito curtas como "Pode.").
- ASR LFM3 erra aprovações curtas ("Partisim", "Podem ver"): considerar `local-whisper-http` para a cascata.
- Mesmo bug de "texto à frente do áudio" no hybrid 10.2 (fatia proporcional sobre o texto todo).
- Repetir as medições com a GPU livre (sem evals concorrentes).
