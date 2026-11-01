# Live Mode: diagnóstico, pesquisa e proposta

> **Data:** 2026-10-31 · **Escopo:** só exploração (nenhum código alterado) · **Base:** commit `d7e659b` (é o mesmo na cópia instalada em `C:\Users\carlos\Documents\agents\ashy`)
>
> **Fontes:** quatro investigações em paralelo:
> - (A) forense do bug da "resposta idêntica", reproduzido no Ollama real;
> - (B) mapa do pipeline de voz atual no código;
> - (C) pesquisa externa de modelos e runtimes, com fontes primárias;
> - (D) estudo de AIRI, Open-LLM-VTuber, Pipecat, LiveKit Agents e kyutai unmute.
>
> O que não foi verificado aparece marcado como **[não verificado]**.

---

## 0. Resumo em 30 segundos

1. **Não existe fallback hardcoded.** O modelo é chamado em todo turno e recebe sua mensagem. A resposta idêntica vem de duas coisas juntas:
   - O GGUF força decodificação gulosa (`top_k=1`) e o app não manda parâmetros de sampling.
   - O histórico da sessão está "envenenado" com placeholders `[Mensagem de voz Omni]` e respostas quase iguais. Um modelo de 2B em modo guloso só copia o padrão anterior.
2. **"Omni Nativo" no Ollama não é speech-to-speech.** O fluxo real é ASR → texto → LLM de texto → `/tts` no final. Mesmo quando chega áudio, **o renderer descarta**, porque o player nunca recebe um `AudioContext`. Por isso você vê só texto.
3. **Sim, é limitação do Ollama.** Ele não gera resposta falada num turno de chat e não tem endpoint realtime. A proposta para isso, a [#19396](https://github.com/ollama/ollama/issues/19396), ainda está aberta.
4. **O caminho para fala→fala local é o llama.cpp ≥ v0.8.0 (`llama-server`).** Ele tem o endpoint **`/v1/realtime`** (WebSocket no estilo OpenAI Realtime), que faz fala→fala com o **LFM3-Omni-2B** e com tool calls. Tem binário pronto para Windows.
5. **Para chegar ao objetivo do `ASHY_PROJECT_CONTEXT` §7** (chamada contínua, baixa latência, interrupção natural, lip-sync), não basta trocar o backend. Falta um **motor de chamada** de verdade:
   - máquina de estados da chamada;
   - player com relógio real;
   - barge-in em tempo real;
   - histórico fiel ao que foi realmente falado;
   - lip-sync a partir do áudio tocado.

   Esse motor serve igual para os modos omni e cascata, local ou nuvem.

---

## 1. Bug: "ela responde sempre a mesma coisa"

Reproduzido no Ollama real com o mesmo formato de request que o app monta (investigação A).

| Causa | Evidência | Confiança |
|---|---|---|
| O GGUF tem `general.sampling.top_k=1`, `temp=0` e `penalty_repeat=1`, e o llama-server aplica esses valores. O app não envia sampling (`turn-orchestrator.ts` ~900). Pelo `/v1/chat/completions`, **não dá para sobrescrever `top_k`**: testado com `temperature 0.8, top_k 40`, a saída foi a mesma. | log `top_k = 1` em todos os turnos; `model_info` | muito alta |
| O histórico reenvia até 80 mensagens de `session-initial` (`MAX_HISTORY_MESSAGES = 80`, `turn-orchestrator.ts:46`). Entre elas estão placeholders `[Mensagem de voz Omni]` antigos e três ou mais respostas "o que você quer que eu analise…". | Com histórico: string idêntica. Sem histórico, ou com só as 2 últimas mensagens: respostas corretas. | alta |
| Turnos de voz antigos, anteriores ao `28a20f4`, foram salvos como placeholder e dispararam o loop. A sessão nunca é rotacionada. | timestamps no `ashy.db` | média |

Hipóteses **descartadas**: truncamento do prompt (1.2–1.3k tokens com n_ctx 4096, `truncated=0`), cache de resposta no app, template de chat quebrado, fallback de saudação.

**Bugs secundários encontrados**
- **"Tchevin" foi alucinação de ASR.** O clipe tinha 10–18 tokens de áudio, bem menos de 1 s, provavelmente cortado pelo VAD. A transcrição errada virou a mensagem do usuário, e numa reprodução o modelo passou a chamá-lo de "Tchevin".
- **O histórico contradiz o system prompt.** As respostas antigas foram salvas sem a tag `<|ACT …|>`, então o modelo deixa de emitir a tag e o Live2D fica sem emoção.
- **O `/tts` gera 0 tokens.** O log mostra `no speaker reference provided`, porque `'ashy-warm-ptbr'` não é uma referência de voz válida.
- **O `think:false` não é respeitado de todo no `/v1`.** O raciocínio liga em todo turno; é inofensivo aqui.
- **Onde ficam os dados de runtime:** `C:\Users\carlos\AppData\Roaming\@ashy\desktop\` (`ashy.db`, `providers.json`). O log do Ollama fica em `C:\Users\carlos\AppData\Local\Ollama\server.log`.

---

## 2. Como o pipeline de voz funciona hoje (investigação B)

### 2.1 Caminho real
```
Mic (AudioWorklet, 16 kHz, OK)
 → VAD por DSP (RMS/ZCR); o Silero existe mas NÃO está ligado
 → turn controller (600/1200/3000 ms, OK)
 ├─ cascata: STT padrão = 'deterministic-wav-stt' (FALSO: devolve frases fixas de teste)
 │            → sendUserMessage(texto)
 └─ omni:   WAV depois de 750 ms de silêncio → preflight de ASR (Web Speech sem chave → host → Ollama ASR)
            → o texto vira a mensagem do usuário ("a fala aparece transcrita")
 → LLM: Ollama /v1/chat/completions (só texto; input_audio só se o ASR falhar)
 → depois do turno inteiro: POST <llama-server>/tts (achado por regex no server.log + PowerShell)
 → turn:audio-delta → GaplessAudioPlayer SEM AudioContext → descartado em silêncio
 → como chegou áudio, o fallback de TTS é pulado → SILÊNCIO TOTAL
```

### 2.2 Problemas, por impacto
1. **Áudio omni nunca toca.** Nada em `apps/desktop/src` passa um `audioContext` para o player (`voice-session-runtime.ts:851-875`, `useAshyStore.ts:1282-1336`).
2. **Não há transporte fala→fala.** Não existe código de WebSocket nem WebRTC no repo. Os presets "gpt-4o-realtime" e "gemini" só existem no nome.
3. **STT e TTS falsos são o padrão em produção.**
   - `deterministic-wav-stt` devolve frases fixas.
   - `local-synth-fallback` é um tom de 185 Hz.
   - O `web-speech-tts` do host é mapeado para esse tom.
   - O STT no renderer roda sem API keys.
4. **Nada é streamado no caminho do Ollama.** A latência soma 750 ms de selamento + ASR + LLM inteiro + TTS inteiro.
5. **Os flags se contradizem.** `unifiedOmniMode`, `directOmniAudio`, `omniExecutionMode` e `supportsOmniAudioOut` competem entre si. O botão "Omni Nativo" liga só um deles.
6. **Não há uma máquina de estados da chamada.**
   - O estado de presença é alterado em uns 15 pontos soltos da store.
   - Não existe o estado "interrompido".
   - O fim da fala vem de um timer estimado, não do fim real do áudio.
   - O barge-in usa `interruptAtMs = 600` fixo.
7. **Os controles de microfone do overlay, do dock e o atalho não ligam o microfone.** Eles só mudam o `micMode`. O wake word vem ligado e trava de novo depois de cada turno.
8. **O lip-sync é aproximado.** Usa o primeiro frame de cada chunk e depois um timer.
9. **Reprodução no modo cascata.** O `new Audio()` é disparado sem esperar, até quatro em paralelo, então pode tocar fora de ordem e não para no barge-in. O speechSynthesis do Windows fica fora do cancelamento de eco do Chromium.
10. **A documentação e o ADR divergem do código.**
    - O ADR-0005 cita arquivos que não existem.
    - O `hybrid-omni-in` só existe como nome.
    - Os testes da 9.2 mockam exatamente os endpoints cuja existência não estava provada.

### 2.3 O que é sólido e dá para reaproveitar
- WAV codec.
- Captura por worklet, com guarda de geração.
- Ring buffer com pre-roll.
- `turn-policy` (CAS) e `turn-intelligence`.
- Chunker e segmentador de markdown.
- `RealtimeSpeechPipeline`, com ordenação e recibos de interrupção.
- `GaplessAudioPlayer`, que funciona assim que receber um `AudioContext`.
- Providers HTTP de STT e TTS no host, com o vault.
- Parse de `delta.audio` no formato OpenAI.
- Extração de vogais a partir do PCM.
- O "epoch/abort" do orchestrator.

---

## 3. O que existe hoje fora do app (investigação C, fontes primárias)

### 3.1 O modelo: LFM3-Omni-2B (lançado em 27/10/2026) [verificado]
- **Entrada:** texto, imagem, vídeo com áudio, e áudio de 16 kHz.
- **Saída:** texto, fala de 24 kHz, ou os dois intercalados (`generation_mode`: `text` | `audio` | `interleaved`).
- **Português:** está na lista de saída de fala (19 idiomas) e de ASR. **[não verificado: se o sotaque é BR ou PT]**
- **Arquivos no repo GGUF:** só o modelo e o `mmproj`. O mmproj já contém o encoder de áudio e o decoder de fala; não há vocoder separado.
  - Q4_K_M: 1,10 GB; mmproj Q4_K_M: 292 MB; mmproj Q8_0: 507 MB.
  - O exemplo de TTS do card usa o mmproj Q8_0.
- **Voz:** definida pelo system prompt (`Perform TTS in <lang> using a <gender> voice.`), só feminina ou masculina. Clonagem com `speaker_ref_b64` funciona no `/tts` e é "highly recommended".
- **Sampling recomendado:** texto guloso; áudio com `temp 0.4` e `rep 1.2`.
- **Limites:** é um 2B sem raciocínio. No benchmark do próprio fabricante, o tool-calling fica bem abaixo dos modelos maiores (52 vs 72).
- **Modelo irmão:** LFM3-Audio-2B, só áudio, também com português.

### 3.2 Ollama (v0.40.13) [verificado]
- **Áudio de entrada:** só funciona colocando o WAV no campo `images` do `/api/chat`. O campo `audio` é descartado sem aviso e o modelo entra em loop ([#19378](https://github.com/ollama/ollama/issues/19378), aberta). Também existe `/v1/audio/transcriptions`.
- **Áudio de saída:** só pelo `/v1/audio/speech`, que é TTS de um texto. A v0.40.13 trouxe TTS do LFM3 para Windows.
- **Não tem:** resposta falada num turno de chat, `/v1/realtime`, VAD ou barge-in.
- **[não verificado]** Se o pull `hf.co/...` carrega o mmproj. As reproduções que funcionam usam a tag de biblioteca `lfm3-omni`.

### 3.3 llama.cpp v0.8.0 (b11960+, hoje b12024) [verificado]
- **`/v1/realtime`** (WebSocket, PR [#31269](https://github.com/ggml-org/llama.cpp/pull/31269)) faz fala→fala com LFM3-Omni e LFM3-Audio, com tool calls.
  - Entrada PCM16 de 16 kHz e saída PCM16 de 24 kHz.
  - Eventos: `session.update`, `input_audio_buffer.append/commit`, `conversation.item.create`, `response.create/cancel`, `response.output_audio.delta`, `response.output_text.delta` e `function_call_arguments`.
- **Limitações importantes:**
  - **Não tem VAD no servidor.** O app detecta o fim da fala e manda `commit` + `response.create`.
  - **Não tem `truncate` nem `input_audio_buffer.clear`.**
  - **`instructions` e `tools` só podem ser definidos antes do primeiro áudio.**
  - Bug [#31436](https://github.com/ggml-org/llama.cpp/issues/31436): saída só de áudio (`["audio"]`) sai embolada. **Use `["text","audio"]`.**
  - Testado só em Mac e CUDA. **[não verificado: estabilidade no Windows]**
- **Outros endpoints:** `POST /tts` (stream, voice, `speaker_ref_b64`) e `/v1/chat/completions` com `input_audio` (sem saída de áudio).
- **Porta padrão:** passou a ser 9931. Passe `--port` explicitamente.
- **Binários Windows:** CUDA 12.4/13.4, Vulkan, CPU.

### 3.4 Alternativas locais de fala→fala
| Modelo | pt-BR | Situação |
|---|---|---|
| **LFM3-Omni-2B / LFM3-Audio-2B** | ✔ (sotaque ?) | **Melhor encaixe hoje.** ~2 GB, roda num llama-server sidecar. |
| Qwen2.5/3-Omni | ? | A fala só existe em Python/vLLM ou em forks; o llama.cpp principal só gera texto. 16 GB+. |
| MiniCPM-o 4.5 | ✘ | Fala só em inglês e chinês. |
| Moshi/Kyutai | ✘ | Só inglês e francês. |
| Ultravox, Voxtral | — | Só áudio de entrada. |

### 3.5 Cascata local para pt-BR
- **Detecção de voz e de fim de fala:** Silero VAD (ONNX) e **Pipecat Smart-Turn v3** (8 MB ONNX, BSD-2; **[não verificado]** a precisão em PT).
- **STT:** whisper.cpp ou faster-whisper large-v3-turbo. Alternativa: Parakeet-TDT-0.6B-v3 via sherpa-onnx, mas ele foi treinado em PT europeu.
- **TTS:**
  - Piper pt_BR (leve, robótico);
  - Kokoro (pf_dora, pm_alex; qualidade em pt incerta);
  - **o `/tts` do LFM3 com speaker ref**, que fica no mesmo sidecar;
  - Chatterbox-pt-br (melhor qualidade, mas precisa de Python e CUDA).
- **Dá para embutir em Node, sem Python:** `sherpa-onnx-node` (VAD, ASR e Piper) e `onnxruntime-node` (Smart-Turn).

### 3.6 Nuvem
| Serviço | Transporte | VAD/turno | Interrupção | Contexto | pt-BR | Preço |
|---|---|---|---|---|---|---|
| **Gemini Live** (`gemini-3.1-flash-live-preview`, `gemini-3.8-live`) | WSS + token efêmero; entrada 16 kHz, saída 24 kHz | VAD no servidor (~800 ms) ou manual | cancela e descarta, flag `interrupted`, **sem truncate** | sessão de áudio de 15 min, precisa de resumption + compression | **✔ explícito** | ~US$ 0,02/min |
| **OpenAI Realtime** (`gpt-realtime-2.1`, `-mini`) | WebRTC / WS / SIP; 24 kHz | `semantic_vad` / `server_vad` / desligado | **`conversation.item.truncate`** | `instructions` mutáveis, sessão de 60 min | ✔ na prática | mini custa 3–7× mais que o Gemini |
| Nova 2 Sonic, Azure Voice Live | — | — | — | — | Sonic ✔ | [não verificado] |
| Cascata em nuvem | Deepgram Flux multi (STT com fim de turno) → LLM → ElevenLabs Flash / Cartesia | | | | | |

---

## 4. Lições dos projetos de referência (investigação D)

| Padrão | De onde | Por que importa |
|---|---|---|
| **Uma interface só para dois backends.** `RealtimeModel` e cascata `stt→llm→tts` atrás da mesma sessão, com um registro de **capabilities** (`message_truncation`, `turn_detection`, `mutable_instructions`, `mutable_chat_context`…). | LiveKit Agents ([agents-js `llm/realtime.ts`](https://github.com/livekit/agents-js/blob/b78ac16/agents/src/llm/realtime.ts#L48-L60), Apache-2.0) | É o núcleo da proposta. O agents-js é TS e dá para portar quase direto. |
| **A cascata fala o protocolo Realtime.** Para o frontend, ela parece um modelo fala→fala. | kyutai unmute (MIT) | O motor só fala um idioma. |
| **Recibo de playback no relógio de áudio.** `stop({fadeMs})` → `{clipId, throughMs}`, e a saída do driver serve de fonte de áudio para o lip-sync. | AIRI `pipelines-audio` (MIT) | Base para truncar no ponto exato e para o lip-sync. |
| **O histórico guarda só o que foi falado.** O agregador do assistente fica depois da saída de áudio; texto não tocado não entra. No realtime, `truncate(itemId, playedMs)`. | Pipecat (BSD-2), LiveKit | Corrige o histórico "envenenado" e as interrupções. |
| **Interrupção falsa.** Pausa a fala em vez de descartar; se não vier transcrição em ~2 s, retoma. Há também min_duration 0,5 s, min_words e um aquecimento do AEC (~3 s). | LiveKit, unmute | Evita que um "hum" ou o eco da própria Ashy cortem a fala. |
| **VAD em duas etapas.** `onSpeechStart` só registra; `onSpeechRealStart` interrompe. | Open-LLM-VTuber | Filtra cliques e ruído. |
| **TTS em paralelo com entrega ordenada** e um chunker com "boost" (os dois primeiros chunks podem cortar em vírgula, mínimo de 4 palavras e máximo de 12). | OLV, AIRI | Reduz o tempo até o primeiro áudio. |
| **Expressões presas ao segmento de fala.** Tag inline → ação Live2D disparada quando aquele segmento começa a tocar. | OLV, Pipecat "expressive" | A emoção acontece junto com a fala certa. |
| **Lip-sync a partir da saída tocada.** RMS em janelas de 20–50 ms; wLipSync (MFCC → AEIOU) num AudioWorklet. | AIRI, OLV | Fica igual nos dois modos e fecha a boca sozinho no fade. |
| **Injeção de memória no gancho `on_user_turn_completed`.** No realtime, via `update_instructions` ou um item de contexto, só se `mutable_*`. | LiveKit | Mantém a "história compartilhada" no modo voz. |
| **Falha tipada ao iniciar a chamada** (`unconfigured`, `microphone-off`, `denied`, `busy`). Playground de VAD com medidor ao vivo. | AIRI | Melhora a experiência de configuração. |

**Licenças:**
- AIRI, Pipecat, LiveKit e unmute são permissivas.
- **O frontend do Open-LLM-VTuber (licença própria) não pode ser copiado.** Dá para usar as ideias, não o código.
- O servidor unspeech é AGPL.
- [verificar] As licenças dos pesos do Smart-Turn e do wLipSync.

---

## 5. Arquitetura proposta: o "Live Call Engine"

### 5.1 Peças e onde cada uma roda
| Peça | Onde | Observação |
|---|---|---|
| Captura de mic (AEC/NS/AGC), resample para 16 kHz, pre-roll de 360 ms | Renderer, AudioWorklet | Já existe. |
| Silero VAD v5 (onnxruntime-web) | Renderer, Web Worker | Liga o que já está escrito. |
| **Playback engine**: um único `AudioContext`, PCM sem gaps, fades, recibos `playedMs`, *output tap* | Renderer, AudioWorklet | Precisa ficar no **mesmo** renderer do mic para o AEC do Chromium funcionar. |
| Lip-sync (RMS → `ParamMouthOpenY`; vogais opcionais) | Renderer, ligado ao output tap | O mesmo nos dois modos. |
| **Call engine**: máquina de estados, turnos, *ledger* de conversa, interrupção | Renderer (TS puro, sem DOM) | Pode migrar depois para um `utilityProcess`. |
| Adapters de backend (WS/WebRTC, STT, LLM, TTS) e chaves | Main ou `utilityProcess`, via MessagePort | As chaves ficam fora do renderer. |
| `llama-server.exe` (LFM3-Omni) e, opcionalmente, whisper/Piper | Sidecar gerenciado pelo `LocalRuntimeManager` | Já existe um gerenciador para o Ollama. |
| Persona, memória e montagem do contexto | Main (DB) | Chamado na fronteira de cada turno. |

### 5.2 Interface única
```ts
interface VoiceSessionCapabilities {
  serverTurnDetection: boolean; messageTruncation: boolean;
  mutableInstructions: boolean; mutableContext: boolean;
  userTranscription: boolean; toolCalls: boolean;
  outputSampleRate: number; textOnlyOutput?: boolean; // hybrid: realtime text + Ashy's own TTS
}
interface VoiceSession {
  caps: VoiceSessionCapabilities
  pushAudio(pcm16k: Int16Array): void
  commitUserTurn(): void; clearInput(): void
  respond(opts?): ResponseHandle; cancelResponse(): void
  truncate(itemId: string, playedMs: number, spokenText: string): Promise<void>
  setInstructions(text: string): Promise<void>; syncContext(msgs): Promise<void>
  on('user_speech_started'|'user_transcript'|'response_audio'|'response_text'|'response_done'|'tool_call'|'error', cb)
}
```
**Implementações:**
- `LlamaCppRealtimeSession` (LFM3-Omni local)
- `GeminiLiveSession`
- `OpenAIRealtimeSession`
- `CascadeSession` (STT → qualquer LLM do vault → chunker → TTS), que fala o mesmo protocolo.

### 5.3 Máquina de estados da chamada
```
idle → listening → user_speaking → thinking → speaking → listening
speaking   --VAD-->            interrupted_pending (pausa/fade, NÃO descarta)
interrupted_pending --palavras/duração-->  interrupted → commit truncado → user_speaking
interrupted_pending --nada em ~2 s-->      speaking (retoma)
thinking   --usuário fala-->   user_speaking (cancela; nada tocado = nada salvo)
qualquer   --erro/desligar-->  idle (motivo tipado)
```
Acrescentar também: janela de aquecimento do AEC e supressão de backchannel ("aham" não interrompe).

### 5.4 Histórico fiel
1. Cada chunk de áudio carrega `{turnId, itemId, segmentId, textSpan}`.
2. O worklet devolve `playedMs`.
3. O `playedMs` vira texto falado: por timestamps de palavra quando existem; senão, segmentos completos mais uma proporção do segmento atual.
4. O **ledger da Ashy** é a fonte da verdade. Grava só o texto falado, com `interrupted: true` e uma nota de sistema opcional.
5. Propagação para o backend:
   - Com `truncate` (OpenAI): chama `truncate`.
   - Sem `truncate` (llama.cpp, Gemini): nota de sistema no próximo turno, ou nova sessão semeada com o ledger.
6. **Nunca persistir placeholders** (`[Mensagem de voz Omni]`) nem texto que não foi tocado.

### 5.5 Memória e persona por tipo de backend
- **Cascata:** no fim do turno do usuário, `persona + memórias(transcrição) + notas de runtime` → LLM.
- **OpenAI Realtime:** `instructions` na conexão e `session.update` antes de cada `response.create`, com `create_response=false`.
- **llama.cpp realtime:** `instructions` e tools ficam **travados depois do primeiro áudio**. Por isso: persona e memórias estáveis entram no `session.update` inicial; as memórias de cada turno entram como item `input_text` (`conversation.item.create`) antes do `response.create`; e a sessão é rotacionada quando necessário.
- **Gemini Live:** client content antes do turno. Para sessões longas, resumption e compression.

---

## 6. Seção "Live Mode" nas Configurações

1. **Modo:** `Omni (fala→fala)` | `Cascata (STT → LLM → TTS)` | `Híbrido (omni ouve, TTS da Ashy fala)`. Esse **seletor único** substitui os quatro flags atuais.
2. **Presets:**
   - "Local omni (LFM3-Omni via llama.cpp)"
   - "Local privado (Whisper + LLM + Piper/Kokoro/LFM-TTS)"
   - "Nuvem realtime (Gemini Live / OpenAI Realtime)"
   - "Nuvem cascata"
3. **Omni:** provedor, modelo, voz (feminina ou masculina, ou *speaker reference* = **a voz da Ashy**), VAD local ou do servidor.
4. **Cascata:** STT (provedor, modelo, idioma), LLM (o do chat ou um "modelo rápido para voz"), TTS (provedor, voz, velocidade, palavras no primeiro chunk).
5. **Turnos:**
   - limiar do VAD com **medidor ao vivo**;
   - silêncio de fim de fala (0,5–3 s);
   - pre-roll;
   - "verificar se terminei" (Smart-Turn);
   - geração preemptiva.
6. **Interrupção:** liga/desliga, duração mínima, mínimo de palavras, retomar em interrupção falsa (2 s), aquecimento do AEC.
7. **Dispositivos:** entrada e saída, AEC e NS, push-to-talk, wake word (**desligado por padrão na chamada**).
8. **Testes e saúde:**
   - teste de microfone com traço do VAD;
   - "diga algo" (preview da voz);
   - **chamada de teste** com latências medidas (fim da fala → primeiro áudio tocado; STT final, LLM TTFT, TTS TTFB);
   - status do sidecar.

---

## 7. Plano de fases (proposta)

> Segue o fluxo **brainstorming → spec → plano → execução com subagentes**. A 10.0 pode correr em paralelo ao brainstorming, porque são correções diretas.

| Fase | Objetivo | Entregas principais |
|---|---|---|
| **10.0 Hotfix (imediato)** | Parar a resposta idêntica e fazer **alguma** voz sair. | - Sanitizar o histórico: remover placeholders, deduplicar e limitar a ~8 msgs ou por orçamento de tokens em modelos pequenos.<br>- Enviar sampling pelo `/api/chat` nativo com `options` (`temperature`, `top_k`, `repeat_penalty`).<br>- Duração mínima de clipe e guarda no ASR.<br>- **Passar um `AudioContext` ao player.**<br>- Tirar o STT e o TTS falsos do padrão de produção.<br>- Rotacionar a sessão envenenada no `ashy.db`. |
| **10.1 Núcleo do Call Engine** | A chamada de verdade, independente de backend. | - Interface `VoiceSession` + capabilities.<br>- Máquina de estados.<br>- Playback engine com recibos.<br>- Lip-sync pelo output tap.<br>- Silero VAD ligado.<br>- Ledger com truncamento fiel.<br>- Barge-in em tempo real com detecção de interrupção falsa.<br>- Controles de mic do overlay e do dock ligados de fato. |
| **10.2 Local omni (llama.cpp)** | LFM3-Omni falando localmente. | - `LocalRuntimeManager` baixa e gerencia o `llama-server` (CUDA, Vulkan ou CPU) com o modelo + mmproj.<br>- `LlamaCppRealtimeSession` em `/v1/realtime`, modo `["text","audio"]`.<br>- Speaker reference da Ashy.<br>- Aposentar o bridge frágil (regex no `server.log`). |
| **10.3 Cascata local** | Opção privada com LLM maior. | - Whisper (sidecar ou sherpa-onnx).<br>- Smart-Turn.<br>- TTS: Piper, Kokoro ou LFM `/tts`.<br>- Streaming por frase em paralelo e ordenado. |
| **10.4 Nuvem realtime** | Melhor qualidade e menor latência. | - `GeminiLiveSession` (padrão).<br>- `OpenAIRealtimeSession`.<br>- Tokens efêmeros emitidos no main. |
| **10.5 UI do Live Mode** | Configurar e diagnosticar. | - Painel da §6.<br>- Presets.<br>- Chamada de teste.<br>- Métricas de latência.<br>- Assistente inicial ("como você quer conversar com a Ashy?"). |
| **10.6 Persona e memória na voz** | A Ashy continua sendo a Ashy na chamada. | - Injeção de memória por tipo de backend.<br>- Tags de emoção presas aos segmentos.<br>- Eval de continuidade em voz. |

Ordem sugerida: **10.0 → 10.1 → 10.2 → 10.5 (mínimo) → 10.4 → 10.3 → 10.6**. Alternativa: começar pela nuvem (10.4) se você quiser a experiência ideal funcionando antes da local.

---

## 8. Decisões para o brainstorming

1. **Pipeline padrão no primeiro uso:** local omni (LFM3, privado, 2B mais limitado) ou nuvem realtime (Gemini Live, melhor e mais barato, mas exige chave)?
2. **O Ollama fica?** Continua para chat de texto e cascata, ou o llama.cpp vira o runtime local único? Ter dois runtimes significa dois downloads e dois processos.
3. **Distribuição do sidecar:** baixar sob demanda (o CUDA tem centenas de MB) ou embutir no instalador? Qual variante usar por padrão (detectar a GPU)?
4. **A voz da Ashy:** usar um *speaker reference* fixo (que áudio de referência? licença da voz?) e a mesma voz em todos os backends? Na nuvem, as vozes são fixas por provedor.
5. **Sotaque:** testar se o PT do LFM3 soa brasileiro antes de fechar o padrão local. Se não soar, usar o híbrido: LFM3 ouve e o TTS pt-BR fala.
6. **Onde roda o engine:** no renderer (mais simples, o AEC funciona) ou num `utilityProcess` (sobrevive a reloads)?
7. **Interrupção no llama.cpp** (sem truncate): aceitar a nota de sistema, ou rotacionar a sessão a cada interrupção?
8. **Escopo da 10.0:** fazer como hotfix agora, antes da spec grande?
9. **Testes:** substituir os mocks dos endpoints por testes de integração opcionais contra um llama-server real, com a tag `@hardware`.

---

### 8.1 Decisões tomadas (2026-10-31)
1. **Sem padrão imposto.** O usuário escolhe o pipeline e o modelo: omni local, realtime na nuvem ou cascata. Nada fica preso a um modelo único.
2. **Ollama e llama.cpp são providers separados**, lado a lado. O llama.cpp não substitui o Ollama.
3. **Voz de referência:** nos backends que aceitam, o usuário envia o próprio áudio de referência. A UI é guiada por capability: o campo de upload só aparece quando o backend suporta.
4. **A 10.0 (hotfix) vem antes** da spec grande. Plano em `docs/superpowers/plans/2026-10-31-phase-10-0-voice-hotfix-plan.md`.

### 8.2 Quem aceita voz de referência (verificado em 2026-10-31)
| Backend | Voz de referência? | Como |
|---|---|---|
| llama.cpp `POST /tts` (LFM3-Omni/Audio) | **Sim** | `speaker_ref_b64` ou upload multipart `speaker_ref`; o README "recomenda fortemente". `voice`: `female`/`male`. |
| llama.cpp `/v1/realtime` (fala→fala) | **Não** | O `session.update` só aceita `type`, `instructions`, `output_modalities`, `max_output_tokens`, `tools`, `tool_choice`. A voz depende das `instructions`. **Para usar uma voz clonada com o LFM3 local: modo híbrido**, com o realtime em `["text"]` e o `/tts` com `speaker_ref`. |
| Ollama `/v1/audio/speech` | Não, e **não funciona com a tag `hf.co/...`** (`"does not support speech"`, testado). | Talvez funcione com a tag de biblioteca `lfm3-omni` **[não verificado]**. |
| OpenAI Realtime / Gemini Live | Não | Vozes fixas do provedor; vira um seletor de voz. |
| Chatterbox / XTTS / F5 (cascata) | Sim | Clonagem por áudio de referência (Python). |
| Piper / Kokoro | Não | Vozes pré-treinadas. |

### 8.3 Verificações ao vivo (2026-10-31, Ollama 0.40.13)
- Só o `/api/chat` nativo respeita `top_k`. No `/v1/chat/completions`, tanto no topo quanto em `options`, o log continua com `top_k = 1`.
- `/v1/audio/transcriptions` funciona com o LFM3 `hf.co`. Com áudio ruim, pode responder em estilo de chat em vez de transcrever.
- O llama-server filho do Ollama `/tts` funciona: 200 `audio/wav`, ~4 s de áudio em 1,3 s. O silêncio no app é do player sem `AudioContext`.

## 9. Próximos passos
1. Você responde às decisões da §8 (sessão de brainstorming).
2. Spec `docs/superpowers/specs/2026-11-xx-phase-10-live-call-engine-design.md` + ADR novo, que substitui partes do ADR-0005.
3. Plano de implementação por fase, com tarefas independentes para subagentes (engine, playback/lip-sync, adapter llama.cpp, adapter Gemini, UI).
4. Execução e verificação real (chamada de teste medindo latência).
5. Depois: `git pull` + reinstalar em `C:\Users\carlos\Documents\agents\ashy`.

**Material bruto das investigações** (clones de referência, reproduções):
- `C:\Users\carlos\AppData\Local\Temp\claude\C--Users-carlos-Documents-projetos-ashy\52ab9d25-93ef-40a6-9ed8-5c67bf95f8b3\scratchpad\refs\`
- `C:\Users\carlos\AppData\Local\Temp\claude\C--Users-carlos-Documents-projetos-ashy\52ab9d25-93ef-40a6-9ed8-5c67bf95f8b3\scratchpad\probe*.mjs`
