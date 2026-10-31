# ASHY — Roadmap por Fases

> **Propósito:** definir o caminho, em fases verificáveis, entre o estado atual do repositório e o objetivo final descrito em [`ASHY_PROJECT_CONTEXT.md`](./ASHY_PROJECT_CONTEXT.md): uma companheira digital que **constrói, preserva e expressa uma história compartilhada** e que **continua reconhecível quando o modelo de linguagem é trocado**.
>
> Este documento complementa a [Especificação de Arquitetura](./ASHY_ARCHITECTURE_SPEC.md) e o [Plano TDD v1](./superpowers/plans/2026-10-28-ashy-v1-foundation.md). Aqueles documentos descrevem *como* cada motor funciona; este define *em que ordem* eles viram um produto real e *como saber* que cada fase terminou.

**Data da análise base:** 2026-10-28 · **Commit base:** `1eba1df`

---

## 1. Ponto de partida (estado verificado)

A base de engenharia é sólida: ~20k linhas TypeScript em 7 pacotes + 1 app, `pnpm test` (99 testes), `pnpm typecheck` e `pnpm build` passando. Porém, **a aplicação é uma demonstração roteirizada**: os motores existem isolados, mas o circuito *conversar → lembrar → reencontrar* não está fechado.

| Área | O que existe de verdade | O que é simulado ou falta |
| :--- | :--- | :--- |
| `@ashy/llm` | Adapters OpenAI-compatível e Anthropic com streaming SSE; parser de marcadores; anti-slop. | **Nunca é chamado pelo app.** |
| `@ashy/cortex` | SQLite (`node:sqlite`) + FTS5, ranker FSRS + RRF, motor de piadas com cooldown, afeto em 4 camadas, *soul composer*. | Sem geração de embeddings; nenhuma extração automática de memórias a partir da conversa; `user_habits` e `prospective_intents` não entram no prompt. |
| `apps/desktop` (store) | UI React com 5 seções e design system. | Respostas da Ashy são **3 frases fixas** (`useAshyStore.ts:982-1035`); o prompt compilado é descartado; Cortex em RAM (`forceMemoryFallback: true`, `useAshyStore.ts:339`); memórias fictícias semeadas no boot. |
| `@ashy/voice` | Ring buffer, turn-policy CAS, TTFA chunker, fila paralela, recibo de barge-in (lógica). | Sem microfone, VAD, STT ou TTS reais — `synthesizeFn` apenas estima duração (`useAshyStore.ts:784`). |
| `@ashy/stage` | Drivers matemáticos (blink, saccades, mola, lip-sync, hit-test). | Avatar = 2 JPGs com transform CSS (`AshyStageCanvas.tsx:567`); sem Tachie em camadas nem Live2D. |
| `@ashy/agency` | Gatekeeper Observe/Prepare/Execute, privacidade, dHash. | Sem cliente MCP real; sem captura de tela. |
| Electron | — | Não é dependência; `electron/main.ts` só retorna um objeto de configuração. |
| Testes E2E | Testes de UI em jsdom. | Sem Playwright. |

**Achado crítico para o diferencial:** com as frases exatas do documento de contexto, `computeMotifRelevance` retorna relevância **0** para o Dia 18 (*"Fui mexer numa biblioteca antiga e deu erro."*) e **0.125** para o Dia 5 (*"Lembra daquele bug? Consegui resolver."*), abaixo do limiar de 0.15 usado pelo app. A relevância é puramente lexical; a piada interna só "funciona" quando o usuário repete as palavras-gatilho — o oposto do que o projeto propõe.

---

## 2. Princípios que governam o roadmap

1. **Fechar o circuito antes de polir as pontas.** Nenhuma fase de voz, avatar ou ferramentas começa antes de a Ashy conversar com um LLM real e lembrar entre sessões.
2. **Seguir a ordem de prioridades do §14 do contexto:** identidade e memória → emoções e evolução → voz e avatar → desktop e ferramentas → mundo próprio.
3. **Medir o diferencial, não só os motores.** O Experimento Central de Validação ganha uma bateria de avaliação automatizada própria (Fase 3) que passa a ser gate para as fases seguintes.
4. **Nenhuma memória sem origem.** Toda memória gravada deve apontar para o(s) episódio(s) real(is) que a originou; zero memórias semeadas ou inventadas.
5. **Reaproveitar o que já existe.** Os pacotes atuais são a base; cada fase pluga I/O real nos motores já testados, em vez de reescrevê-los.
6. **Cada fase termina com critérios de saída verificáveis** (teste automatizado, avaliação ou demonstração reproduzível).

---

## 3. Visão geral das fases

```mermaid
flowchart LR
    F1["Fase 1\nRuntime real\n(Electron + ashy.db + LLM)"] --> F2["Fase 2\nMemória que se\nescreve sozinha"]
    F2 --> F3["Fase 3\nValidação do\nExperimento Central"]
    F3 --> F4["Fase 4\nEmoções e\nevolução reais"]
    F3 --> F5["Fase 5\nVoz em\ntempo real"]
    F5 --> F6["Fase 6\nCorpo digital\ne presença"]
    F4 & F6 --> F7["Fase 7\nDesktop, visão\ne MCP"]
    F7 --> F8["Fase 8\nIniciativa e\nmundo próprio"]
    F8 --> F81["Fase 8.1\nLatência, Thinking\n& Adapters LLM"]
    F81 --> F82["Fase 8.2\nUnificação Modelos,\nCatálogo & UI"]
    F82 --> F83["Fase 8.3\nMemória Seletiva,\nFim DEMO_* & Córtex"]
    F83 --> F84["Fase 8.4\nLive2D Universal,\nPalco & Electron"]
    F84 --> F85["Fase 8.5\nTools no Chat,\nPermissões & Visão"]
    F85 --> F86["Fase 8.6\nPipeline Real Voz\n(Local + Nuvem)"]
    F86 --> F87["Fase 8.7\nModelo Omni Unificado\n(LFM3-Omni-2B & Cloud)"]
    F87 --> F9["Fase 9\nProtótipo público"]
    F9 --> F10["Fase 10\n3D / XR\n(futuro)"]
```

| Fase | Nome | Pilar do contexto | Marco |
| :--- | :--- | :--- | :--- |
| 1 | Runtime real | §9 Local-first | **M1 — A Ashy conversa de verdade** |
| 2 | Memória que se escreve sozinha | §4 Memórias | |
| 3 | Validação do Experimento Central | §14 Experimento | **M2 — Diferencial provado em texto** |
| 4 | Emoções e evolução reais | §5, §6 | |
| 5 | Voz em tempo real | §7 | |
| 6 | Corpo digital e presença | §8 | **M3 — Companheira com voz e corpo** |
| 7 | Desktop, visão e MCP | §10 | |
| 8 | Iniciativa contextual e mundo próprio | §11 | **M4 — Presença completa** |
| 8.1 | Latência, Controle de Thinking & Adapters LLM | §9, §14 | ✅ Concluída |
| 8.2 | Unificação de Modelos LLM, Catálogo/Busca & Limpeza UI | §9 | ✅ Concluída |
| 8.3 | Memória Seletiva Real, Fim de `DEMO_*` & Córtex/Dream Real | §4, §5, §11 | ✅ Concluída |
| 8.4 | Estado Universal da Personagem (Live2D), Palco & Electron | §8 | ✅ Concluída |
| 8.5 | Tools/MCP no Chat, Permissões Unificadas & Visão/Desktop Reais | §10 | ✅ Concluída |
| 8.6 | Pipeline 100% Real de Voz (STT/TTS Local + Nuvem, Mic, Lip-Sync) | §7, §8 | **M4.5 — Zero Mocks em Produção** (✅ Concluída) |
| 8.7 | Modelo Omni Unificado (Voz, Texto, Imagem e Vídeo Local `LFM3-Omni-2B` & Cloud) | §7, §8, §9, §10 | **M4.7 — Omni Unificado** (✅ Concluída) |
| 9 | Protótipo público | §15 | **M5 — Release 1.0** |
| 10 | 3D e XR | §8 (futuro) | |

---

## Fase 1 — Runtime real (Electron + `ashy.db` + LLM)

**Objetivo:** substituir a demo roteirizada por um ciclo de conversa real e persistente, ainda só em texto.

### Entregas
1. **Processo Main do Electron real** (`apps/desktop/src/main/`):
   - Adicionar `electron` como dependência; criar `BrowserWindow` do Hub e preload com `contextBridge`.
   - Orquestrar serviços via `@ashy/bus` (`createContainer`) no Main: Cortex, provedores LLM, Gatekeeper.
   - IPC tipado renderer ↔ main usando o `event-bus` existente (RPC de streaming para tokens).
2. **Persistência:** Cortex rodando no Main sobre arquivo `ashy.db` em `app.getPath('userData')`; remover `forceMemoryFallback` do caminho de produção; versionar migrations do schema.
3. **Ciclo de turno real:** reescrever `sendUserMessage` para:
   `compileTurnPrompt` → `streamText` (adapter ativo) → `createTailSafeMarkerParser`/categorizer → UI em streaming → sinais `<|ACT|>` aplicados ao afeto (`recordEmotionPulse`) → `<|CALLBACK id|>` registrado em `recordJokeCallback`.
4. **Configuração de provedores:** tela de Modelos com provedor, modelo, base URL e chave de API (OpenRouter, Anthropic, OpenAI, NVIDIA NIM, Ollama). Chaves guardadas no Main com `safeStorage`, nunca no renderer.
5. **Começar do zero:** remover as memórias, marcos e piadas semeados do boot de produção (mantê-los apenas como *fixtures* de teste). A primeira conversa cria o marco `first_meeting`.
6. **Limpezas:** remover `timeLabel: '21:15'` e `screenContext` fixos; histórico de chat persistido por sessão.

### Critérios de saída
- Conversar com um modelo real, fechar o app, reabrir: histórico, humor e traços persistem.
- Trocar de provedor na UI sem reiniciar e sem perder estado.
- Nenhuma string de resposta da Ashy hardcoded no código de produção.
- Teste de integração no Main com `createScriptedMockModel` cobrindo o ciclo completo do turno.

---

## Fase 2 — Memória que se escreve sozinha

**Objetivo:** a Ashy passa a criar, consolidar, recuperar e esquecer memórias a partir das conversas reais — o coração do projeto (§4).

### Entregas
1. **Segmentação de episódios:** fronteiras *soft* (≥ 30 min de pausa ou mudança de assunto) e *hard* (> 3 h), gerando `EpisodicMemory` com resumo produzido por LLM.
2. **Extração estruturada pós-episódio** (LLM com saída validada por Valibot):
   - fatos semânticos candidatos → `runPredictCalibrateConsolidation` (já existente);
   - candidatos a motivos relacionais (metáforas, apelidos aceitos, momentos de riso mútuo);
   - intenções prospectivas (`trigger_at` / `trigger_context`);
   - observações de hábitos;
   - marcação de *flashbulb* por surpresa/valência.
   - Regra: **todo item extraído carrega `source_episode_ids`**; itens sem evidência são descartados.
3. **Embeddings:** interface `EmbeddingProvider` em `@ashy/llm` com opção local (ex.: Ollama/modelo ONNX) e remota; gerar embeddings para episódios, fatos e `trigger_cues`; avaliar `sqlite-vec` versus a solução atual (JSON + cosseno em JS) conforme o volume.
4. **Relevância semântica das piadas internas:** combinar a relevância lexical atual com similaridade de embedding entre o contexto e os `trigger_cues`/origem do motivo. **Teste de regressão obrigatório com as frases exatas dos Dias 1, 5 e 18 do contexto.**
5. **Loop FSRS real:** após cada turno, avaliar quais memórias recuperadas foram usadas na resposta (`good`/`easy`) ou ignoradas (`again`/`hard`) e chamar `reviewMemory`.
6. **Prompt completo:** incluir intenções prospectivas e hábitos relevantes no prefixo dinâmico do `soul-composer`.
7. **Controle do usuário:** Memory Inspector e Our Story operando sobre dados reais do `ashy.db` — visualizar, corrigir, apagar (com remoção de embeddings e FTS) e escolher o que exige confirmação antes de ser guardado (decisão aberta do §15).

### Critérios de saída
- O cenário "fantasma no backend" roda ponta a ponta com as frases do documento de contexto, sem palavras-gatilho artificiais: a piada nasce no Dia 1, é retomada no Dia 5, fica bloqueada por cooldown logo depois e volta no Dia 18.
- Fatos contraditórios são invalidados (`invalid_at`) e não aparecem no prompt.
- Apagar uma memória a remove de todas as buscas.
- Nenhuma memória no banco sem episódio de origem.

---

## Fase 3 — Validação do Experimento Central (**Marco M2**)

**Objetivo:** transformar o Experimento Central (§14) em uma bateria de avaliação reproduzível que mede o diferencial do projeto — e que passa a ser gate de regressão para todas as fases seguintes.

### Entregas
1. **Pacote `evals/`** (ou `packages/evals`) com:
   - **Roteiros de convivência:** semanas simuladas de conversa (com relógio controlado), incluindo nascimento de piadas, projetos, fatos que mudam, momentos sérios e intenções futuras.
   - **Usuário simulado** (LLM) para variar o fraseado e evitar que o teste dependa de palavras exatas.
   - **Troca de modelo:** os mesmos roteiros rodados com o modelo A até o dia N e com o modelo B depois.
2. **Métricas** (determinísticas quando possível, *LLM-as-judge* com rubrica fixa quando necessário):
   - *Recall* de memória relevante e precisão (memórias irrelevantes injetadas);
   - taxa de callback de piada no momento certo × repetição mecânica;
   - **memórias alucinadas** (afirmações sobre o passado sem episódio de origem) — meta: zero;
   - consistência de estilo/identidade antes × depois da troca de modelo;
   - respeito ao *Seriousness Gate* (nenhuma piada em momento delicado);
   - presença de clichês de assistente (anti-slop).
3. **Relatório** por execução (markdown/JSON) e job manual/agendado em CI com limites mínimos.

### Critérios de saída
- Relatório mostrando que, após a troca do modelo A → B, recall, callbacks e identidade se mantêm dentro de uma margem definida, com zero memórias alucinadas.
- O teste atual de *soul portability* (que só verifica o conteúdo do prompt) é complementado por esta avaliação comportamental.

> **Este é o ponto em que o projeto demonstra seu diferencial central em texto.** As fases seguintes dão expressão e presença a uma personalidade que já foi provada.

---

## Fase 4 — Emoções e evolução reais

**Objetivo:** acontecimentos reais influenciam o comportamento de forma gradual, contextual, auditável e reversível (§5, §6, §11 *Personality Evolution*).

### Entregas
1. **Afeto dirigido pela conversa:** humor da sessão atualizado pelos sinais `<|ACT|>` reais e pela reação do usuário; persistência e decaimento já existentes conectados ao ciclo real.
2. **Seriousness Gate híbrido:** manter as regras regex como piso rápido e adicionar classificação leve por LLM (ou modelo local pequeno) para casos não cobertos; medir falsos negativos na bateria da Fase 3.
3. **Dream & Reflection real:** agendador no Main que roda ao fim da sessão ou após inatividade; consolida episódios, detecta conexões entre eles, revisa FSRS e **propõe** deltas de traço justificados por episódios específicos.
4. **Evolução auditável:** propostas registradas em `personality_evolution_log` com explicação legível; tela *Personality & Dream Center* com histórico e **Revert** sobre dados reais; limites de deriva para preservar a identidade-base.
5. **Salvaguardas de vínculo (§6, §12):** regras no prompt e checagens na avaliação contra indução de culpa por ausência, cobrança de atenção ou fingir necessidades humanas; honestidade sobre afetos simulados.

### Critérios de saída
- Traços nunca mudam sem episódio de origem; toda mudança é reversível pela UI.
- A bateria da Fase 3 inclui cenários de tom sério e de manipulação de vínculo, todos passando.

---

## Fase 5 — Voz em tempo real

**Objetivo:** conversa por voz fluida, com baixa latência e interrupção natural (§7), plugando I/O real em `@ashy/voice`.

### Entregas
1. **Captura:** `getUserMedia` + `AudioWorklet` alimentando o ring buffer existente (fonte com AEC/NS/AGC e fonte crua).
2. **VAD:** Silero VAD (ONNX, local) ligado ao `createSpeechActivityTracker`/`createVoiceTurnController`.
3. **STT:** interface `SttProvider` com opção local (ex.: Whisper/Sherpa) e em nuvem; streaming quando disponível.
4. **TTS:** interface `TtsProvider` com opção local (ex.: Kokoro) e em nuvem (ex.: ElevenLabs, OpenAI, Azure) implementando `synthesizeFn` de verdade; reprodução *gapless* via `AudioContext`.
5. **Turn-taking real:** `VoiceEndJudge` e `SpeculativeRephrase` usando um modelo rápido configurável.
6. **Barge-in real:** fade-out, `PlaybackReceipt` calculado a partir do relógio de áudio e nota `[Interrupted after Xs — user only heard: "..."]` injetada no próximo turno.
7. **Wake word** (opcional nesta fase) e modos Mic: mudo / contínuo / push-to-talk.
8. **Fixtures de áudio** (`assets/audio-fixtures/*.wav`) para testes determinísticos.

### Critérios de saída
- Latência até o primeiro áudio (TTFA) medida e registrada por provedor, com metas definidas a partir das primeiras medições.
- Interromper a Ashy no meio da fala faz o próximo turno reagir à interrupção.
- Pausas de pensamento do usuário não cortam a fala dele (cenário do CAS reproduzido com áudio real).

---

## Fase 6 — Corpo digital e presença (**Marco M3**)

**Objetivo:** dar expressão visual à personalidade, com o avatar sincronizado com a fala e presente no desktop (§8).

### Entregas
1. **Identidade visual original da Ashy** (decisão aberta do §15): arte final em camadas Tachie — corpo, olhos (aberto/meio/fechado), sobrancelhas por emoção, bocas A/E/I/O/U, acessórios/efeitos — em `assets/default-avatar/`.
2. **Renderer Tachie real** (Canvas/PixiJS) dirigido pelos drivers existentes: auto-blink, saccades, respiração, mola 120 Hz, emoções das 13 categorias.
3. **Lip-sync acústico:** análise do áudio de TTS (ex.: wLipSync/MFCC em AudioWorklet) alimentando o driver *Winner + Runner-Up*.
4. **Janela Stage Overlay real:** `BrowserWindow` transparente, sem moldura, always-on-top, com click-through via `setIgnoreMouseEvents(…, { forward: true })` e a máscara de silhueta gerada a partir do avatar renderizado.
5. **Controles rápidos e atalhos globais:** Mic, Eyes, DND e Ocultar, sempre acessíveis.
6. **Live2D (opcional nesta fase):** importador `.model3.json` usando o `live2d-inspector` existente.

### Critérios de saída
- Ashy fala com lip-sync e expressões coerentes com os marcadores `<|ACT|>` recebidos.
- Cliques em áreas transparentes passam para as janelas de baixo; cliques no avatar e nos controles funcionam.
- Ocultar/silenciar a Ashy leva um clique ou um atalho.

---

## Fase 7 — Desktop, visão e ferramentas MCP

**Objetivo:** a Ashy acompanha e ajuda em atividades autorizadas, com execução previsível e controlável (§10).

### Entregas
1. **Cliente MCP real** com `@modelcontextprotocol/sdk` (transportes stdio e HTTP) conectado ao `ProgressiveMcpRegistry` existente (3 meta-tools no prompt).
2. **Gatekeeper ligado à UI:** `PendingActionCard` no Hub e no balão da Ashy com diff/comando/caminho, **Aprovar 1x / Aprovar na sessão / Recusar**; `action_audit_log` persistido no `ashy.db`.
3. **Classificação de risco por ferramenta** configurável pelo usuário (`observe-only`, `read-safe`, `staged-confirm`), com escopos de pasta autorizados.
4. **Visão autorizada:** modo Eyes (desligado por padrão / janela selecionada / tela) via `desktopCapturer`, filtro dHash para descartar quadros repetidos e provedor de visão plugável.
5. **Consent Center:** lista do que foi acessado ou modificado, revogação de permissões.

### Critérios de saída
- Uma ferramenta de escrita (ex.: `write_file`, `run_command`) nunca executa sem aprovação explícita — coberto por teste E2E.
- Com Eyes desligado, nenhum quadro de tela é capturado.
- Todo acesso e ação aparecem no audit log.

---

## Fase 8 — Iniciativa contextual e mundo próprio (**Marco M4**)

**Objetivo:** a Ashy toma iniciativa com motivo concreto e ganha um espaço próprio que reflete a história compartilhada (§11).

### Entregas
1. **Loop de atenção:** avalia `prospective_intents`, conquistas a acompanhar e temas recorrentes; gera turnos proativos com silêncio seletivo (o *soul composer* já suporta *"Speak about this notice only if it fits now, or stay quiet."*).
2. **Limites de iniciativa:** frequência máxima, horários de silêncio, DND e modulação por `user_habits` — tudo configurável (decisão aberta do §15).
3. **Our Story** como linha do tempo viva sobre marcos reais, com busca e edição.
4. **Ashy's Room:** ambiente que reflete horário e itens desbloqueados por marcos reais de `autobiographical_milestones`.
5. **Diário de reflexão** (opcional): registros do Dream & Reflection legíveis pelo usuário, sem vivências inventadas.

### Critérios de saída
- Toda iniciativa espontânea referencia um item real (intenção, marco ou tema) e respeita DND e horários de silêncio.
- A bateria da Fase 3 passa a medir iniciativas inoportunas ou sem motivo.

---

## Estabilização e Desmockagem Pré-Fase 9 (Fases 8.1 a 8.6 — **Marco M4.5 — ✅ Concluído**)

**Objetivo:** eliminar todos os mocks, simulações, estados hardcoded, *split-brains* de configuração e gargalos de latência identificados na auditoria pós-Fase 8, garantindo que 100% dos fluxos de conversação, memória, avatar Live2D, tools e voz operem de verdade antes da Release 1.0.

### Fase 8.1 — Latência, Controle de Thinking & Adapters LLM 100% Reais (✅ Concluída)
1. **Controle de `reasoningEffort` (`'none' | 'minimal' | 'low' | 'medium' | 'high'`):** suporte nos adapters (`@ashy/llm`) e no `ProviderVault` para enviar `reasoning: { enabled: false }` / `reasoning: { effort }` (OpenRouter), `reasoning_effort` (OpenAI/compatíveis), `enable_thinking: false` (Qwen/Ollama) e `thinking` (Anthropic), com **default `'none'`** para conversação instantânea (TTFT < 1.5s) e seletor na UI de modelos.
2. **Remoção do overhead síncrono pré-turno:** eliminar o `await options.getBootstrapSnapshot()` bloqueante do início de `runTurnPipeline` em `turn-orchestrator.ts`, cachear chaves descriptografadas em memória no `ProviderVault`, passar `stage: relationship.stage` e `queryEmbedding` real em `compileTurnPrompt`, e inserir a mensagem do usuário otimisticamente no Zustand antes do retorno do RPC.
3. **Correção do Adapter Anthropic & JSON Schema de Tools:** serializar `m.toolCalls` como blocos `tool_use` em `createAnthropicMessagesModel`, repassar `temperature` e capturar `usage` real; expandir `valibotSchemaToJsonSchema` para suportar `union`, `literal`, `record` e `description`.

### Fase 8.2 — Unificação de Modelos LLM, Catálogo/Busca por Provider & Limpeza da UI de Configurações (✅ Concluída)
1. **Fim do Split-Brain (`SUPPORTED_MODELS`):** remover `SUPPORTED_MODELS` e `activeModelId` hardcoded de `useAshyStore.ts` e `App.tsx`, conectando toda a UI (topbar, stage overlay, popover de contexto e configurações) diretamente ao `ProviderVault` (`state.providers`).
2. **Seletor e Pesquisa Dinâmica de Modelos por Provider:** criar RPC `listProviderModels` em `provider-vault.ts` consultando `GET /v1/models` (OpenRouter, OpenAI, NVIDIA NIM, Anthropic) e `/api/tags` (Ollama local) com combobox pesquisável, filtro por nome/ID e botão de atualizar catálogo em `ModelsSettingsPanel.tsx` e `FirstMeetingWizard.tsx`.
3. **Sub-abas Funcionais & Limpeza de Botões de Simulação na UI:** fazer as sub-abas `Geral`, `Voz`, `Modelos` e `Privacidade` filtrarem os cards correspondentes; tornar real o botão `"Salvar preferências"` (`saveUserPreferences`); exibir relógio/data reais na pré-visualização; e remover da UI de produção os botões falsos de cenários/benchmarks (`btn-scenario-*`, `<div style={{ display: 'none' }}>`, painel M2 em Nossa História, botões de iniciativa `14:00`/`02:30`, fixtures `.wav`, ataques MCP e fixtures de visão).

### Fase 8.3 — Memória Seletiva Real, Fim de `DEMO_*` & Desmockagem do Córtex/Dream/Proatividade (✅ Concluída)
1. **Fim do Spam de "Momentos":** parar de criar rascunhos `ep-turn-*` para qualquer mensagem `>= 12` chars em `indexTurnMemory`, filtrar rascunhos fora de `mapEpisodesToMemoryCards` e corrigir o detector de `topic_shift` em `detectEpisodeBoundary` para ignorar saudações/mensagens curtas (`"opa"`).
2. **Extração Estruturada & Dream Worker com LLM Real:** conectar `resolveDreamJsonGenerator` e `consolidateSessionMemories` ao modelo ativo com gate `shouldSaveEpisode: boolean` (descartando conversas triviais), classificação real de categoria (`momentos`, `sobre_voce`, `referencias`, `planos`), visual distinto por categoria (fim da imagem repetida `/assets/mem-first-chat.jpg`), e reflexão noturna (`DreamJournalEntry` + evolução dos 5 traços incluindo `chaosEnergy`) gerada pelo LLM em vez de templates/regex, além de configurar `DEFAULT_DREAM_IDLE_TIMEOUT_MS`.
3. **Remoção de `demo-seed.ts` de Produção, Embeddings Reais & Iniciativa Proativa Real:**
   - Remover `DEMO_MEMORY_CARDS`, `seedAshyDemoFixtures` e `buildRoomTrophies` hardcoded de produção, além do fallback `'Carlos'` / `/assets/carlos-avatar.jpg`;
   - Corrigir o formulário `"O que aprendi sobre você"` (`App.tsx`) para permitir escolher categoria e predicado reais em vez de fixar `favorite_stack_is`;
   - Remover a trava `embedding.length === 128` em `inside-joke-engine.ts`, `dream-worker.ts` e `fsrs-turn-loop.ts`, remover as stopwords técnicas de teste (`banco`, `codigo`, `projeto`) e integrar `EmbeddingProvider` real;
   - Conectar o `AttentionLoop` a um timer real no `kernel.ts` que consulta o LLM ativo (removendo `buildDefaultGroundedReply` estático), grava as mensagens proativas no SQLite e emite evento SSE/IPC.
4. **Higiene da Construção do Prompt (`[Context]`) & Correção dos Bugs Diagnosticados pela Própria Ashy:**
   - Corrigir o pareamento em `extractEpisodeDeterministic` (`episode-extractor.ts`) para nunca juntar `userMessages[0]` (pergunta do Turno 1) com `assistantMessages[last]` (resposta do Turno N), pareando sempre a fala do usuário com a resposta imediatamente subsequente da Ashy;
   - Impedir que mensagens proativas (`msg-proactive-*`) sem fala do usuário sejam consolidadas como `Usuário: <fala da Ashy> | Ashy: <fala da Ashy>`, marcando-as como consolidadas ao nascer;
   - Filtrar de `compileTurnPrompt` memórias que já estão visíveis no `conversationHistory` da sessão ativa e instruir explicitamente em `buildStaticSoulSystemPrompt` (`[INTERNAL CORTEX RECALL — HOW TO READ [Context]]`) que o bloco `[Context]` é memória silenciosa do próprio córtex (e não texto colado pelo usuário);
   - Executar higienização automática (`pruneCorruptedAndTrivialEpisodes`) no boot do `AshyCortex` para limpar episódios corrompidos/triviais legados do `ashy.db` local e reparar resumos com turnos trocados.

### Fase 8.4 — Estado Universal da Personagem (Live2D), Palco 100% Real & Shell Electron (✅ Concluída)
1. **Avatar Universal em Toda a UI:** substituir as tags `<img src="/assets/ashy-hero.jpg">` hardcoded na Sidebar (`App.tsx:763-774`) e no card de Pré-visualização de Configurações (`App.tsx:4852-4870`) pelo componente universal conectado ao `AshyStageCanvas`.
2. **Persistência e Sincronização Multi-Janela:** persistir `stageMode`, `live2dPresetId`, `live2dModelUrl`, `live2dModelControls`, `ambientLuminance` e `showDesktopAvatar` no Host e sincronizar via IPC/SSE entre a janela principal e a `overlayWindow`.
3. **Desmockagem de `@ashy/stage` e Electron:**
   - Conectar o rastreamento do mouse ao `gazeTarget` em `AshyStageCanvas.tsx`;
   - Corrigir `motionImpulse` congelado em `t = 0.12`;
   - Acionar `model.expression(...)` e `model.motion(...)` reais no Cubism 4 em `Live2DWebGLStage.tsx`, carregar controles do `.model3.json` real e extrair a silhueta real do canvas para click-through;
   - Importar `'electron'` corretamente em `preload/index.ts`, implementar os 3 atalhos globais (`Mic`, `Eyes`, `DND`) em `main/index.ts`, remover `src/electron/*` duplicado e conectar os botões `Minimizar / Maximizar / Fechar` da janela.

### Fase 8.5 — Conexão das Tools/MCP ao Chat, Permissões Unificadas & Visão/Desktop Reais (✅ Concluída)
1. **Injeção de Tools no Chat (`TurnOrchestrator` + `SoulComposer`):** injetar o `agencyRuntime` em `turn-orchestrator.ts`, passando `tools` (`search_mcp_tools`, `get_mcp_tool_details`, `call_mcp_tool` e tools autorizadas) para `streamText` e descrevendo as capacidades no prompt, roteando toda execução pelo `ActionGatekeeper` e `AuditLog`.
2. **Eliminação do Runtime Duplicado no Browser & Persistência de Permissões:** remover `let agency = createAgencyRuntime()` de `useAshyStore.ts`, hidratar `snapshot.agency` no `applyBootstrapSnapshot`, remover os `.catch(() => {})` silenciosos e conectar todos os switches (`Mostrar avatar`, `Ações no computador`, `Horários de silêncio`) ao Host.
3. **Desmockagem das Tools Nativas, Visão e MCP Externo em `agency-runtime.ts`:**
   - Substituir `buildPatternFrame` (36x32 falso) e o `visionProvider` stubado por captura real de tela/janela (`desktopCapturer` no Electron / `getDisplayMedia` no browser) e chamada real ao modelo de visão/VLM ativo;
   - Tornar reais `get_active_window_title` (janela ativa real do SO), `read_workspace_file` (remover fallback falso `export const PACKAGE_NAME = "@ashy/desktop"`, incluir `process.cwd()` em `allowedPaths`) e `run_cleanup_command` (executar comando real via `child_process` após aprovação no Gatekeeper);
   - Enviar `notifications/initialized` em `mcp-client.ts` e reconectar `externalMcpServers` salvos no boot do Host.

### Fase 8.6 — Pipeline 100% Real de Voz (Modelos Locais & Nuvem de STT/TTS, Microfone, VAD e Lip-Sync) (✅ Concluída)
1. **Suporte Completo a Modelos Locais e em Nuvem (STT & TTS) via Host Bridge & Cofre Seguro:**
   - **STT Local da escolha do usuário:** servidores locais OpenAI-compatible (`faster-whisper-server` / Speaches, `whisper.cpp`, LocalAI, Ollama) com Base URL + Model ID customizável e listagem de modelos, além de **Web Speech API nativa** (`SpeechRecognition` PT-BR).
   - **STT em Nuvem:** OpenAI Audio (`gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `whisper-1`), Groq Whisper (`whisper-large-v3-turbo`), integrados ao `ProviderVault`.
   - **TTS Local da escolha do usuário:** Kokoro-FastAPI, Piper HTTP, OpenedAI-Speech, Coqui XTTS / AllTalk (com Base URL + seleção de modelo e voz) + **Web Speech Synthesis nativo** (`speechSynthesis` listando vozes PT-BR do sistema).
   - **TTS em Nuvem:** OpenAI TTS (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd` + vozes `coral`, `nova`, `shimmer`, etc.) e ElevenLabs (`eleven_multilingual_v2`, `eleven_flash_v2_5` + listagem de vozes da conta), decodificando `WAV`/`MP3`/`Opus`/`PCM` via `AudioContext.decodeAudioData`.
   - Desativar `allowOfflineFallback: true` silencioso para `deterministic-wav-stt` e `local-synth-fallback`, e atualizar `DEFAULT_VOICE_RUNTIME_SETTINGS`.
2. **UI Completa de Configuração de Voz:** seletores reais de provedor (Local vs. Nuvem), modelo, voz, microfone físico (`enumerateDevices`), Base URL/API Key, toggle `"Falar respostas automaticamente"` e botões reais de `"Testar Microfone"` e `"Testar Voz"`.
3. **Captura Real de Microfone, VAD ONNX, Turn-Taking com LLM & Lip-Sync Acústico no Live2D:**
   - Implementar `getUserMedia` + `AudioContext` + `AudioWorkletNode` em `voice-session-runtime.ts`, integrar Silero VAD ONNX em `vad-engine.ts`, injetar `llmJudgeFn`/`llmRephraseFn` reais em `turn-intelligence.ts` e remover o hack de `advanceSilence(1200)`;
   - Ligar os botões `"Conversar por voz"` e `"Voz local"` à escuta real (removendo `toggleSimulatedSpeech()`), disparar `sendUserMessage` automaticamente em `onTurnSealed`, remover a frase falsa de `triggerBargeIn`, sintetizar o áudio real das respostas em `createPipelineForTurn` e sincronizar o lip-sync do Live2D e as `WAVEFORM_BARS` com o áudio real no `AudioContext` (voltando `isSpeaking: false` ao fim do playback).

---

### Fase 8.7 — Modelo Omni Unificado: Voz, Texto, Imagem e Vídeo em 1 Único Modelo Local (`LFM3-Omni-2B`) & Cloud (✅ Concluída)
1. **Protocolo & Adaptador Multimodal Unificado (`@ashy/shared`, `@ashy/llm`, `ProviderVault`):**
   - Suporte nativo a **1 único modelo Omni** (`native-omni`, `hybrid-omni-in`, `modular`) capaz de receber **Áudio (`input_audio` 16kHz WAV/PCM16)**, **Texto**, **Imagem (`image_url`)** e **Vídeo (`video_frame` a 2 fps deduplicado por dHash)** na mesma requisição.
   - Presets de 1 clique com foco local no **`LFM3-Omni-2B`** (`lfm3-omni:2b` / `LiquidAI/LFM3-Omni-2B-GGUF` com `think: false`, `LiquidCodec` 24kHz `pt-BR` e KV cache tri-híbrido) e provedores Cloud (`gpt-4o-audio-preview`, `qwen/qwen2.5-omni-7b`, `google/gemini-2.5-flash`).
   - Streaming de áudio nativo (`turn:audio-delta` + `turn:input-transcript`) com auto-downgrade transparente em HTTP 400 para `hybrid-omni-in` (TTS fallback) quando o endpoint retornar apenas texto.
2. **Preservação da Alma (`voice.md`) e Sinais de Palco `<|ACT|>` sem Vazamento na Voz Nativa (`@ashy/cortex`, `TurnOrchestrator`):**
   - Extração dual-channel de `<|ACT|>`, `<|DELAY|>` e `<|CALLBACK|>` + tool `ashy_stage_signal` para que o modelo Omni acione emoções, gestos do Live2D e piadas internas sem pronunciar tags de controle em voz alta no stream de áudio.
3. **Áudio Direto (`directOmniAudio`), Amostrador de Vídeo (`2 fps`) e Lip-Sync Acústico no Live2D (`@ashy/voice`, `omni-media-sampler.ts`, `useAshyStore.ts`, `App.tsx`):**
   - Envio direto do bloco de fala do VAD (com pré-rolagem de `360ms` e proteção CAS) em WAV 16kHz para o modelo Omni (`onOmniAudioTurnReady`), pulando STT intermediário.
   - Reprodução imediata dos chunks `turn:audio-delta` (`24kHz PCM16`/`WAV`) no `GaplessAudioPlayer` alimentando o lip-sync formante (`A, E, I, O, U, S` + `rawVolume`) do Live2D em tempo real e recibo exato de Barge-In (`computeOmniPlaybackReceipt`).
   - Captura e amostragem de vídeo (webcam ao vivo a `2 fps`, tela contínua e upload `.mp4`/`.webm`) integrada ao `PrivacyController` (`activateFullPrivacyShield`), mais controles dedicados no Estúdio e em `Ajustes > Modelos` / `Ajustes > Voz`.

---

## Fase 9 — Protótipo público (**Marco M5 — Release 1.0**)

**Objetivo:** tornar a Ashy instalável, segura e compreensível para outras pessoas.

### Entregas
1. **Empacotamento** (ex.: electron-builder) para Windows, macOS e Linux; atualização automática.
2. **Onboarding:** escolha de provedores (local/nuvem), permissões explicadas, primeira conversa.
3. **Portabilidade da alma:** exportar/importar `ashy.db` (memórias, traços, exemplos de estilo) e apagar tudo com um clique.
4. **Privacidade e segurança:** criptografia em repouso do banco (opcional), revisão de segurança do IPC e do MCP, nenhuma telemetria sem consentimento.
5. **Suíte E2E Playwright** cobrindo os 6 fluxos do Plano TDD (Tarefa 7.2) sobre o app Electron real.
6. **Documentação:** guia de usuário, guia de provedores, ADRs (`docs/adr/`) das decisões tomadas nas fases anteriores.

### Critérios de saída
- Instalação limpa em máquina nova até a primeira conversa sem passos manuais além da configuração de provedor.
- E2E e bateria do Experimento Central verdes no commit de release.

---

## Fase 10 — 3D e XR (futuro)

Expansão desejada, não requisito do protótipo (§8): renderer VRM respeitando o mesmo contrato do `@ashy/stage` (emoções, lip-sync, olhar), e exploração de presença em XR. Só começa após a Release 1.0.

---

## 4. Trabalho transversal (todas as fases)

- **Gate de qualidade:** `pnpm test`, `pnpm typecheck` e `pnpm build` verdes em todo PR; adicionar CI (GitHub Actions) já na Fase 1.
- **Bateria do Experimento Central** (a partir da Fase 3) rodando em cada fase como regressão do diferencial.
- **Memória técnica:** decisões arquiteturais registradas como ADR em `docs/adr/`.
- **Guardrails do §12** ("O que a Ashy não deve ser") traduzidos em cenários de avaliação.

## 5. Decisões abertas (§15) e quando resolvê-las

| Decisão | Fase em que precisa estar fechada |
| :--- | :--- |
| Temperamento inicial exato (a spec propõe energética/provocadora + Seriousness Gate) | Fase 1 (afeta os *Golden Dialogue Exemplars*); calibrar com dados na Fase 3 |
| Quais memórias são guardadas automaticamente × exigem escolha do usuário | Fase 2 / Fase 8.3 |
| Até onde a personalidade pode evoluir sem perder a identidade | Fase 4 / Fase 8.3 |
| Identidade visual, voz e linguagem corporal | Fases 5, 6, 8.4 e 8.6 |
| Quando ela pode iniciar uma conversa por conta própria | Fase 8 / Fase 8.3 |
| Funcionalidades indispensáveis para o primeiro protótipo público | Antes da Fase 9 (Fases 8.1 a 8.6) |

## 6. O que evitar

- Investir mais em matemática de avatar, otimizações de áudio ou polimento de UI antes dos Marcos M1 e M2 — essas partes já estão à frente do núcleo.
- Semear memórias fictícias em builds de produção.
- Considerar uma fase concluída apenas porque os testes unitários dos motores passam: o critério é o comportamento ponta a ponta definido em cada fase.
