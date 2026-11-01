# Relatório da noite (2026-11-01): Live Mode completo

> **Para:** Carlos, pela manhã
> **Escopo pedido:**
> 1. omni local e na nuvem funcionando (conversa, tools, contexto configurável);
> 2. Live Mode com omni **e** com a pipeline clássica, validado;
> 3. controle de contexto de alto padrão;
> 4. modelos pequenos funcionando bem.
>
> **Base:** `260fed2` (10.3). Todos os commits da noite estão em `main`, enviados ao GitHub.

## TL;DR

| Pedido | Estado | Como foi verificado |
|---|---|---|
| Laço "Olá, Carlos! Tudo bem…" | ✅ Causa encontrada e corrigida | Reproduzido com a **cópia** do seu banco e corrigido. A sequência da sua conversa agora recebe respostas reais. |
| Omni local (LFM3) | ✅ Funciona. **O padrão agora é o híbrido.** | Harness de avaliação real (llama-server + LFM3): **83%** dos turnos aprovados, contra 43% antes; híbrido 45/49. No seu banco contaminado: 86% (era 50%); híbrido 15/15. |
| Omni na nuvem (OpenAI, Qwen-Omni, Gemini Live, qualquer endpoint compatível) | ⚠️ Implementado e testado **só contra servidores falsos** | Não há nenhuma chave de nuvem na máquina. Passo a passo de validação na §5 do `2026-11-01-cloud-realtime-backends.md`. |
| Pipeline clássica (STT → modelo de texto → TTS) | ✅ Funciona de ponta a ponta | Execução real com **qwen3:4b-instruct** (baixado no Ollama): respostas boas, memória dentro da chamada, interrupção fiel, **"anota…" → "Pode sim" → nota salva**. |
| Controle de contexto / memória | ✅ Bem mais forte | Memória injetada só como fatos sobre você e o que você mesmo disse (nunca frases da Ashy); turnos triviais e eco não viram memória; memórias antigas contaminadas são ignoradas, sem apagar nada. Recall dentro da chamada e entre chamadas aprovado no harness. |
| Modelos pequenos | ✅ qwen3:4b (texto) e LFM3-2B híbrido | Limites conhecidos na §4. |

## 1. O laço das respostas iguais

Com a cópia do seu banco, achei **três causas** que se reforçavam:

1. **Memórias contaminadas.** Cada turno levava "Memórias relevantes" com trechos crus de conversas antigas, como `Usuário: Olá. | Ashy: Olá, Carlos! Tudo bem…`. O modelo de 2B copiava essas frases, as respostas ruins eram gravadas como memória nova, e o ciclo se realimentava.
2. **Rotação de sessão com resumo** (entrou na 10.2). Uma resposta repetida disparava uma sessão nova, e o resumo levado para ela continha a saudação. O modelo copiava a saudação, o que disparava nova rotação.
3. **Modo áudio intercalado do LFM3 em várias rodadas.** Ele degrada mais que o modo texto: repete a abertura e ecoa a sua fala.

**O que foi corrigido:**
- **Memória para a chamada:** só fatos e o que você disse, filtrados por relevância, até 3 linhas. Nunca as palavras antigas da Ashy.
- **Indexação de memória:** eco, saudação vazia e placeholders não entram. Fatos pessoais (nome do pet, onde mora, gostos) passam a ser extraídos.
- **Leitura de memória:** os pares contaminados antigos são pulados na leitura, sem apagar nada.
- **Rotação:** só acontece depois de duas repetições seguidas. O resumo traz apenas os temas que **você** trouxe.
- **Prompt:** papéis explícitos, saudar uma vez só, não repetir a sua fala.
- **Híbrido:** guarda contra eco (corta a abertura que repete a sua fala antes do TTS) e contra ela chamar você de "Ashy".
- **Padrão:** o backend padrão virou `llamacpp-hybrid`, com migração única. Se você escolher o realtime depois, a escolha é mantida.

Detalhes e números: `docs/superpowers/research/2026-11-01-small-model-conversation-quality.md`. Para rodar o harness: `node scripts/eval-live-conversation.mjs --userdata <cópia> --backend both`.

## 2. Backends do Live Mode

Configurações › Live Mode, cinco cartões:

| Backend | Para quê | Estado |
|---|---|---|
| **Local omni + minha voz (híbrido)** — padrão | O LFM3 entende e responde em texto, e o `/tts` fala, com voz de referência opcional | ✅ real; ~2 s da sua fala até o áudio dela |
| Local omni (realtime) | O LFM3 fala→fala direto, com menor latência (~1,3 s) | ✅ real, mas repete mais em conversas longas |
| **Pipeline clássica** | STT → **qualquer** modelo de texto (Ollama, OpenRouter, Anthropic…), com persona, memória e ferramentas do chat → TTS por frase | ✅ real com qwen3:4b-instruct e com o LFM3 |
| OpenAI Realtime / compatível | OpenAI, **Qwen-Omni (DashScope)** ou URL própria (`wss://…` ou `ws://127.0.0.1…` local) | ⚠️ só testes com servidores falsos |
| Gemini Live | Áudio nativo do Gemini, com retomada de sessão | ⚠️ só testes com servidores falsos |

**Contexto configurável na nuvem:** persona on/off, mensagens recentes, memórias por turno e tamanho máximo das instruções.

**Chaves de API:** ficam criptografadas no host. Um relay local conecta ao provedor, então a chave nunca chega ao renderer.

**Ferramentas:** funcionam em todos os backends, inclusive na nuvem e na cascata (dentro do turno do orquestrador).

## 3. Pipeline clássica com modelo pequeno (execução real)

| Pergunta (voz) | Resposta dela (qwen3:4b-instruct) |
|---|---|
| "Me conta uma curiosidade sobre Júpiter." | "Júpiter tem 90 vezes mais massa que a Terra… os dias dele são quase 10 horas…" |
| "Me explica… buraco negro…", interrompida | Gravado só "Ah, Carlos, você quer tudo sobre" (interrompida); a resposta seguinte resumiu em uma frase |
| "Anota pra mim: comprar leite amanhã" | "Pode aprovar a anotação 'Comprar leite'?" |
| "Pode sim, por favor." | "Salvo! 'Comprar leite' tá na sua lista…" |
| "Você lembra qual é o meu nome e do que eu gosto?" | "Claro que sim, Carlos! Você adora astronomia…" |

**Latência:** a mediana do fim da fala ao primeiro áudio ficou em 3,5–5 s, **medida com a GPU sobrecarregada**. Com o TTS em streaming (último commit da noite), o primeiro áudio de cada frase saiu em 0,3–0,6 s, contra 2–9 s antes. O primeiro turno já não fica mudo: o modelo de texto é aquecido no início da chamada.

**Configuração recomendada:** Pipeline clássica → LLM `ollama` + modelo `qwen3:4b-instruct` → TTS "Voz local do llama.cpp". O modelo já está baixado no seu Ollama.

## 4. Limites conhecidos (honestos)

- **Nuvem nunca rodou contra um provedor real.** Precisa da sua chave; checklist na §5 do `2026-11-01-cloud-realtime-backends.md`.
  - Qwen e Gemini recebem o contexto de memória **um turno depois**, porque esses servidores respondem sozinhos.
  - O "Testar chamada" na nuvem ainda usa o `/tts` local para gerar a pergunta.
- **A GPU de 8 GB fica apertada.** Na noite estavam carregados ao mesmo tempo o seu app (`llama-server`), o Ollama (LFM3 + qwen) e os testes.
  - ✅ **Resolvido no fim da noite:** nos backends locais e na cascata, a transcrição agora usa o **próprio motor da Ashy** (`/v1/audio/transcriptions` do llama-server, ~223 ms, mesma precisão do Ollama). O Ollama fica só como fallback e deixa de manter uma segunda cópia do LFM3 durante as chamadas.
  - Medições em `2026-11-01-stt-llamacpp.md`.
  - Se você usar o Ollama no chat de texto, ele ainda carrega o modelo dele, e descarrega sozinho depois de alguns minutos sem uso.
- **LFM3-2B:** erra fatos ("capital da Austrália = Sydney"). No modo realtime ainda ecoa algumas frases curtas e repete a abertura. O híbrido é melhor.
- **Transcrição de frases muito curtas:** "Pode." às vezes não é transcrito. Para aprovar por voz, prefira "Pode sim, por favor."
- **Na nuvem, a visão vai como texto,** descrita pelo modelo local. O motor ainda não envia imagens para a nuvem.
- **Código legado não removido:** os flags omni antigos (`unifiedOmniMode`, `directOmniAudio`) e o caminho `turn:audio-delta` do chat continuam no código, sem uso pelo Live Mode.

## 5. Qualidade e testes

- **Testes unitários:** 984 de 985. A única falha é a antiga `phase-8-2-ui-models-and-settings` #5, que já falhava antes desta fase.
- **E2E (Playwright):** 7 de 7 fluxos, incluindo o novo **Live Call**. Corrigido um **bug real** do overlay: o ponto de estado da chamada bloqueava o click-through naquele canto.
- **Wireback:** todas as fases passam, inclusive a nova Phase 10 (139 checagens de segurança: chaves fora do renderer, SHA fixado, chave via env, escopo de headers).
- **Documentação:** ADR-0008, USER_GUIDE §7, PROVIDER_GUIDE §6 e as pesquisas em `docs/superpowers/research/2026-11-01-*.md`.

## 6. O que testar ao acordar

1. Abra o Ashy (reinstalado pelo `install.ps1`) e vá em **Configurações › Live Mode**. O backend deve estar em **híbrido**.
2. **Testar chamada:** as 6 etapas devem aparecer com ✓.
3. **Ligar** e repetir a sua sequência ("Olá", "O que você sabe fazer?", …). Use fone de ouvido.
4. **Pipeline clássica:** escolha `ollama` + `qwen3:4b-instruct` e TTS llama.cpp. Peça "anota…" e depois diga "Pode sim, por favor."
5. Se tiver uma chave (Gemini é a mais barata), coloque em Live Mode › Gemini e ligue.
