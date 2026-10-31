# Guia de Provedores e IA Local — Ashy 1.0 (Marco M5 — Release 1.0)

A **Ashy 1.0** foi construída sobre uma arquitetura desacoplada em que a **alma e a memória** residem localmente no `AshyCortex` (`ashy.db`), enquanto a geração de linguagem, visão e voz pode operar em **3 arquiteturas intercambiáveis**:

1. **`native-omni` (Modo Omni Nativo — 1 Único Modelo):** Um único modelo multimodal recebe **áudio bruto do microfone (`16kHz`)**, **texto**, **imagens** e **quadros de vídeo (`2 fps` deduplicados por `dHash`)** na mesma requisição, e devolve simultaneamente **texto + áudio nativo (`24kHz`)** em streaming.
2. **`hybrid-omni-in` (Modo Híbrido Omni-In):** O modelo recebe diretamente **áudio bruto (`16kHz`) + vídeo (`2 fps`) + texto** sem precisar de STT separado, e responde em texto ultrarrápido que é sintetizado pelo motor TTS escolhido.
3. **`modular` (Modo Modular Clássico):** Pipeline especializado combinando **STT** (Local ou Nuvem) $\rightarrow$ **LLM** (Ollama, OpenRouter, Anthropic, OpenAI, NVIDIA NIM) $\rightarrow$ **TTS** (Kokoro, Piper, ElevenLabs, OpenAI TTS ou Web Speech API).

---

## Sumário

1. [Modo Local / Omni Unificado (`LFM3-Omni-2B`)](#1-modo-local--omni-unificado-lfm3-omni-2b)
2. [Modo Cloud / Híbrido Omni (`gpt-4o-audio-preview`, `Qwen 2.5 Omni 7B`, `Gemini 2.5 Flash`)](#2-modo-cloud--híbrido-omni-gpt-4o-audio-preview-qwen-25-omni-7b-gemini-25-flash)
3. [Provedores LLM Modulares (OpenRouter, Anthropic, OpenAI, NVIDIA NIM e Ollama Local)](#3-provedores-llm-modulares-openrouter-anthropic-openai-nvidia-nim-e-ollama-local)
4. [Provedores de Voz Modulares — STT & TTS (Locais e em Nuvem)](#4-provedores-de-voz-modulares--stt--tts-locais-e-em-nuvem)
5. [Segurança de Chaves (`safeStorage`) e Solução de Problemas](#5-segurança-de-chaves-safestorage-e-solução-de-problemas)

---

## 1. Modo Local / Omni Unificado (`LFM3-Omni-2B`)

O caminho recomendado para rodar a Ashy **100% local, privado, gratuito e com baixa latência** em máquinas com GPU moderada ou CPU moderna é o modelo multimodal **`LFM3-Omni-2B`** (Liquid AI), que unifica audição, visão, conversa e síntese de voz em um único processo.

### Como funciona o pipeline `native-omni` na Ashy

- **Entrada de Áudio Direta (`16kHz PCM16 / WAV`):** Quando você fala no microfone, o detector Silero VAD recorta o turno de fala (incluindo os `360ms` de pré-rolagem do Ring Buffer) e envia o bloco `input_audio` diretamente em `16kHz` para o modelo (`directOmniAudio`), eliminando a etapa intermediária de transcrição STT.
- **Saída de Áudio `LiquidCodec` (`24kHz`) + Lip-Sync Formante:** O modelo transmite chunks `turn:audio-delta` em `24kHz` (`LiquidCodec` `pt-BR`) junto com a transcrição sincronizada (`turn:input-transcript`). O `GaplessAudioPlayer` reproduz os pacotes imediatamente enquanto o extrator de formantes alimenta os visemas `A, E, I, O, U, S` e `rawVolume` do avatar Live2D/Tachie.
- **Quadros de Vídeo a `2 fps` Deduplicados por `dHash`:** Quando a webcam ou a visão de tela (`Eyes`) está ativa, o `omni-media-sampler.ts` amostra até **`2 fps`** e aplica um hash perceptual **dHash de 64 bits**. Quadros estáticos ou repetidos (distância de Hamming abaixo do limiar) são descartados antes do envio, economizando tokens e mantendo o KV-Cache tri-híbrido enxuto.
- **Controle `reasoningEffort: 'none'` (`think: false`):** Para conversação natural em tempo real (TTFT / TTFA $< 1.5\text{s}$), a Ashy configura `reasoningEffort: 'none'` por padrão, enviando `think: false` / `enable_thinking: false` / `reasoning: { enabled: false }` para que o modelo responda imediatamente sem atraso de cadeia de pensamento oculta.
- **Preservação de `<|ACT|>` sem Vazamento no Áudio:** A Ashy utiliza extração dual-channel e a tool `ashy_stage_signal` para que o modelo acione emoções, gestos do Live2D e `<|CALLBACK|>` de piadas internas sem jamais soletrar tags de controle em voz alta.

---

### Opção 1A: Configurando o `LFM3-Omni-2B` no Ollama (`http://127.0.0.1:11434`)

1. **Instale o Ollama** ([ollama.com](https://ollama.com)) e certifique-se de que o serviço está em execução.
2. **Baixe e inicie o modelo `lfm3-omni:2b`:**
   ```bash
   ollama run lfm3-omni:2b
   ```
3. **Verifique se o endpoint local responde:**
   - Endpoint padrão do Ollama: `http://127.0.0.1:11434` (API OpenAI-compatible em `http://127.0.0.1:11434/v1`).
4. **Ative na Ashy com 1 clique:**
   - No **Wizard de Onboarding** (opção **Local Omni `LFM3-Omni-2B`**) ou em **`Ajustes > Modelos`**, clique no preset **`LFM3-Omni-2B (Local Ollama)`** (`preset-omni-lfm3-local`):
     - **Provider:** `ollama`
     - **Base URL:** `http://127.0.0.1:11434/v1` (ou `http://127.0.0.1:11434`)
     - **Model ID:** `lfm3-omni:2b`
     - **Arquitetura Omni:** `native-omni`
     - **Reasoning Effort:** `none` (`think: false`)

---

### Opção 1B: Configurando o `LFM3-Omni-2B` no `llama-server` (`http://127.0.0.1:8080/v1`)

Se você prefere máxima performance em C++/GGUF via `llama.cpp` (`llama-server`):

1. **Suba o `llama-server` apontando para o repositório GGUF oficial `LiquidAI/LFM3-Omni-2B-GGUF`:**
   ```bash
   llama-server \
     -hf LiquidAI/LFM3-Omni-2B-GGUF \
     --host 127.0.0.1 \
     --port 8080 \
     -c 8192 \
     -ngl 99
   ```
2. **Configure na Ashy (`Ajustes > Modelos`):**
   - Selecione o preset **`LFM3-Omni-2B (llama-server GGUF)`** ou preencha:
     - **Base URL:** `http://127.0.0.1:8080/v1`
     - **Model ID:** `LiquidAI/LFM3-Omni-2B-GGUF`
     - **Arquitetura Omni:** `native-omni`
     - **Reasoning Effort:** `none` (`think: false`)

> **Auto-Downgrade Transparente (`native-omni` $\rightarrow$ `hybrid-omni-in`):** Se uma build específica do servidor local ainda não suportar saída de áudio `LiquidCodec` e retornar `HTTP 400` ao solicitar modalidade `audio` na saída, o adaptador da Ashy faz **auto-downgrade transparente para `hybrid-omni-in`** na mesma hora: continua enviando áudio 16kHz + vídeo 2fps diretamente ao modelo, recebe a resposta em texto e aciona automaticamente o seu provedor de TTS local para a voz da Ashy sem interromper a conversa.

---

## 2. Modo Cloud / Híbrido Omni (`gpt-4o-audio-preview`, `Qwen 2.5 Omni 7B`, `Gemini 2.5 Flash`)

Se você não quiser rodar pesos locais ou desejar capacidade multimodal em nuvem, a Ashy traz presets prontos em **`Ajustes > Modelos`**:

| Modelo / Preset | Provedor | Model ID | Modo Padrão | Como opera na Ashy |
| :--- | :--- | :--- | :--- | :--- |
| **OpenAI GPT-4o Audio** | OpenAI / OpenRouter | `gpt-4o-audio-preview` | `native-omni` | Recebe áudio 16kHz WAV (`input_audio`) + imagens/quadros `2 fps` e retorna stream de áudio PCM16 24kHz + transcrição nativa. |
| **Qwen 2.5 Omni 7B** | OpenRouter / vLLM Local | `qwen/qwen2.5-omni-7b` | `native-omni` (c/ auto-downgrade `hybrid-omni-in`) | Suporta compreensão nativa de áudio, vídeo (`2 fps` `dHash`) e texto, com síntese de áudio nativa ou fallback automático para TTS caso o endpoint de terceiros retorne apenas texto. |
| **Google Gemini 2.5 Flash** | OpenRouter / Google OpenAI-compat | `google/gemini-2.5-flash` | `hybrid-omni-in` | Recebe áudio bruto (`input_audio` 16kHz), quadros de vídeo (`2 fps`) e texto diretamente com janela ampla e baixa latência, delegando a síntese vocal ao motor TTS configurado em `Ajustes > Voz`. |

---

## 3. Provedores LLM Modulares (OpenRouter, Anthropic, OpenAI, NVIDIA NIM e Ollama Local)

Em **`Ajustes > Modelos`**, você pode conectar qualquer provedor de linguagem e **trocar de modelo a qualquer momento sem perder a memória nem a personalidade da Ashy**:

### Catálogo Dinâmico e Controle de Thinking (`reasoningEffort`)
- Clique em **Atualizar catálogo** para buscar em tempo real os modelos disponíveis na sua conta ou servidor local (`GET /v1/models` ou `GET /api/tags` no Ollama) e filtre pelo combobox pesquisável.
- **Seletor de `reasoningEffort`:**
  - `'none'` *(Padrão recomendado para conversa fluida)*: desativa blocos longos de pensamento (`reasoning: { enabled: false }` no OpenRouter, `enable_thinking: false` no Qwen/Ollama), garantindo início de fala rápido;
  - `'minimal' | 'low' | 'medium' | 'high'`: habilita raciocínio estendido (`reasoning_effort`, `thinking` no Anthropic Claude ou `reasoning: { effort }` no OpenRouter). Qualquer bloco `<think>...</think>` emitido pelo modelo é isolado pelo categorizador de stream e nunca vaza para a voz da Ashy.

### Configuração por Provedor

1. **OpenRouter (`openrouter`):**
   - **Base URL:** `https://openrouter.ai/api/v1`
   - **API Key:** `sk-or-v1-...`
   - **Modelos recomendados:** `anthropic/claude-3.7-sonnet`, `openai/gpt-4o`, `qwen/qwen2.5-omni-7b`, `google/gemini-2.5-flash`, `deepseek/deepseek-chat-v3-0324`.

2. **Anthropic (`anthropic`):**
   - **Base URL:** `https://api.anthropic.com/v1`
   - **API Key:** `sk-ant-...`
   - **Suporte nativo:** API Messages (`/v1/messages`) com blocos `tool_use` reais, cache de prefixo e controle de `temperature`/`thinking`.

3. **OpenAI (`openai`):**
   - **Base URL:** `https://api.openai.com/v1`
   - **API Key:** `sk-proj-...`
   - **Modelos recomendados:** `gpt-4o`, `gpt-4o-mini`, `gpt-4o-audio-preview`.

4. **NVIDIA NIM (`nvidia-nim`):**
   - **Base URL:** `https://integrate.api.nvidia.com/v1`
   - **API Key:** `nvapi-...`
   - **Uso:** Modelos Llama, Nemotron, Mistral e Qwen acelerados em nuvem via endpoint compatível com OpenAI.

5. **Ollama Local (`ollama`):**
   - **Base URL:** `http://127.0.0.1:11434/v1` (ou `http://127.0.0.1:11434`)
   - **API Key:** Não requer chave (pode deixar em branco ou `ollama`).
   - **Descoberta automática:** Lista todos os modelos baixados localmente via `/api/tags` + `/v1/models` (ex.: `lfm3-omni:2b`, `qwen2.5:7b`, `llama3.2:3b`).

---

## 4. Provedores de Voz Modulares — STT & TTS (Locais e em Nuvem)

Quando você usa um LLM no modo **`modular`** (ou **`hybrid-omni-in`** para a saída de voz), a aba **`Ajustes > Voz`** permite escolher livremente os motores de **Reconhecimento de Fala (STT)** e **Síntese de Voz (TTS)** — combinando opções locais e em nuvem como preferir.

### 4.1 Provedores de STT (Speech-to-Text — Ouvir Você)

#### Opções 100% Locais
1. **`faster-whisper-server` / Speaches / `whisper.cpp` (OpenAI-Compatible Local):**
   - **Como subir (exemplo via Docker c/ `faster-whisper-server`):**
     ```bash
     docker run --rm -p 8000:8000 fedirz/faster-whisper-server:latest-cpu
     ```
   - **Como subir com `whisper.cpp` (`whisper-server`):**
     ```bash
     whisper-server -m models/ggml-base.bin --host 127.0.0.1 --port 8000 --inference-path "/v1/audio/transcriptions"
     ```
   - **Configuração em `Ajustes > Voz > STT`:**
     - **Provedor STT:** `Local OpenAI-Compatible Whisper` (`local-openai-stt`)
     - **Base URL:** `http://127.0.0.1:8000/v1`
     - **Model ID:** `Systran/faster-whisper-small` (ou `whisper-1` / modelo listado pelo botão de catálogo)
2. **Web Speech API Nativa (`web-speech-stt`):**
   - Usa o reconhecedor nativo do navegador/sistema (`SpeechRecognition` configurado para `pt-BR`) sem exigir servidor adicional.

#### Opções em Nuvem (Baixíssima Latência)
1. **Groq Whisper (`groq-stt`):**
   - **Base URL:** `https://api.groq.com/openai/v1`
   - **Model ID:** **`whisper-large-v3-turbo`** (transcrição em poucas centenas de milissegundos)
   - **API Key:** Sua chave Groq (`gsk_...`), protegida no `ProviderVault`.
2. **OpenAI Audio (`openai-stt`):**
   - **Base URL:** `https://api.openai.com/v1`
   - **Model ID:** **`gpt-4o-mini-transcribe`** (também suporta `gpt-4o-transcribe` e `whisper-1`).

---

### 4.2 Provedores de TTS (Text-to-Speech — A Voz da Ashy)

No modo modular, o pipeline da Ashy utiliza o **`MarkdownSegmenter`** + **`TTFA Boost Chunker`** (`4..12` palavras nos dois primeiros fragmentos para começar a falar quase instantaneamente) e uma **fila paralela 4x reordenada** que entrega áudio *gapless* ao `AudioContext`.

#### Opções 100% Locais
1. **Kokoro-FastAPI (`http://127.0.0.1:8880/v1`):**
   - Síntese neural local leve e expressiva com endpoint compatível com `/v1/audio/speech`.
   - **Como subir (Docker):**
     ```bash
     docker run --rm -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
     ```
   - **Configuração em `Ajustes > Voz > TTS`:**
     - **Provedor TTS:** `Kokoro-FastAPI / Local OpenAI Speech` (`local-openai-tts` / `kokoro-local`)
     - **Base URL:** `http://127.0.0.1:8880/v1`
     - **Model ID:** `kokoro`
     - **Voz:** Selecione no catálogo (ex.: `pf_dora`, `af_heart`, `af_bella`).
2. **Piper HTTP (`piper-local`):**
   - Síntese ultrarrápida em CPU para português (`pt_BR-faber-medium` / vozes ONNX locais) via servidor HTTP local.
   - Configure a **Base URL** do seu servidor Piper HTTP (ex.: `http://127.0.0.1:5000`) e escolha a voz carregada.
3. **Web Speech API (`web-speech-tts`):**
   - Utiliza o sintetizador nativo do sistema operacional (`window.speechSynthesis`), listando automaticamente todas as vozes `pt-BR` instaladas no Windows, macOS ou Linux.

#### Opções em Nuvem
1. **ElevenLabs (`elevenlabs-tts`):**
   - **Base URL:** `https://api.elevenlabs.io/v1`
   - **Modelos suportados:**
     - **`eleven_flash_v2_5`** *(Recomendado para conversação em tempo real com baixíssimo TTFA)*;
     - **`eleven_multilingual_v2`** *(Máxima nuance emocional em português)*.
   - **Voz:** Informe sua `XI-API-Key` e clique para listar diretamente as vozes da sua conta ElevenLabs.
2. **OpenAI Audio TTS (`openai-tts`):**
   - **Base URL:** `https://api.openai.com/v1`
   - **Modelos:** `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`
   - **Vozes:** `coral`, `nova`, `shimmer`, `alloy`, `echo`, `sage`.

---

## 5. Segurança de Chaves (`safeStorage`) e Solução de Problemas

### Como suas chaves de API são guardadas
- Nenhuma chave de API fica exposta em texto puro no `localStorage` do navegador nem entra em arquivos exportados `.ashy-soul`.
- O `ProviderVault` no processo Host criptografa todas as credenciais em repouso usando a API nativa **`safeStorage`** do Electron (DPAPI no Windows, Keychain no macOS, Secret Service no Linux) ou chave mestra `AES-256-GCM` local, mantendo cache descriptografado apenas em memória volátil do Host para evitar overhead de I/O entre turnos.

### Checklist Rápido de Diagnóstico
- **O catálogo do Ollama aparece vazio:** Verifique se `ollama serve` está rodando em `http://127.0.0.1:11434` e se você já baixou ao menos um modelo (`ollama pull lfm3-omni:2b`).
- **A latência até a primeira resposta está alta em modelos com raciocínio (Qwen3 / DeepSeek / Claude):** Em `Ajustes > Modelos`, altere **Esforço de Raciocínio (`reasoningEffort`)** para **`none`** — isso envia `think: false` / `reasoning: { enabled: false }` e reduz o TTFT para menos de `1.5s`.
- **Quero testar se o microfone e o TTS estão funcionando antes de conversar:** Em `Ajustes > Voz`, selecione seu microfone físico real na lista de dispositivos, clique em **Testar Microfone** e depois em **Testar Voz**.
