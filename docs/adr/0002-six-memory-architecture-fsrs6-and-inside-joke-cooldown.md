# ADR-0002: Arquitetura de 6 Memórias com Proveniência Obrigatória, Curva de Esquecimento FSRS-6 e Motor de Piadas Internas com `CooldownLock`

- **Status:** Accepted
- **Date:** 2026-10-31
- **Milestone:** M2 — Memória que se Escreve Sozinha & Fase 8.3 — Memória Seletiva Real

---

## Context

Sistemas convencionais de RAG tratam memória como uma coleção plana de fragmentos de chat indexados por cosseno. Em uma companheira de longo prazo, essa abordagem falha em três frentes críticas:
1. **Poluição por trivialidades e alucinações:** Saudações curtas (*"opa"*, *"tudo bem?"*) ou respostas antigas descontextualizadas inundam o prompt, ou o modelo inventa memórias sem lastro real.
2. **Ausência de esquecimento orgânico:** Fatos passageiros de meses atrás competem com memórias emocionais marcantes (*Flashbulb*) ou hábitos ativos.
3. **Saturação de piadas internas:** Se uma piada interna entra no prompt sem controle, o LLM a repete em quase todos os turnos até torná-la irritante; se depende apenas de palavras-chave exatas, falha quando o usuário descreve uma situação análoga com outras palavras.

## Decision

1. **Modelo Cognitivo de 6 Memórias com Proveniência Obrigatória (`source_episode_ids`):**
   - Estruturamos o `AshyCortex` em 6 tabelas especializadas:
     1. `episodic_memories` (episódios segmentados por fronteiras *soft* $\ge 30\text{ min}$ / mudança de tópico e *hard* $> 3\text{ h}$, filtrados pelo gate `shouldSaveEpisode` para descartar turnos triviais);
     2. `semantic_facts` (fatos consolidados via **`Predict -> Calibrate`**, onde fatos contraditos recebem `invalid_at` e saem das buscas ativas);
     3. `autobiographical_milestones` (marcos de **Nossa História** e troféus do **Quarto da Ashy**);
     4. `inside_joke_motifs` (motivos relacionais, metáforas e apelidos compartilhados);
     5. `prospective_intents` (intenções futuras com gatilho temporal ou contextual);
     6. `user_habits` (padrões observados de rotina e estilo de trabalho).
   - **Invariante de Proveniência:** Nenhuma memória semântica, motivo ou evolução de traço é persistida sem apontar para `source_episode_ids` reais existentes no banco. Zero memórias semeadas (`DEMO_*`) em produção.

2. **Recuperação Híbrida (`FTS5` BM25 + Vetorial + RRF) Ponderada por FSRS-6:**
   - Combinamos busca lexical `FTS5` (BM25) e similaridade de cosseno sobre embeddings reais usando **Reciprocal Rank Fusion (RRF, $k = 60$)**.
   - Cada memória mantém estado completo **FSRS-6** (`stability`, `difficulty`, `retrievability`, `last_reviewed_at`). Após cada turno (`fsrs-turn-loop.ts`), memórias efetivamente utilizadas na resposta recebem avaliação positiva (`good`/`easy`) e memórias ignoradas recebem (`again`/`hard`).
   - Memórias marcadas como **Flashbulb** (alta valência/surpresa emocional) têm piso mínimo de recuperabilidade garantido (`FLASHBULB_MIN_RETRIEVABILITY = 0.68`) para nunca desaparecerem por decaimento temporal.

3. **Motor de Piadas Internas Híbrido com `CooldownLock`:**
   - `computeMotifRelevance` combina relevância lexical e similaridade semântica vetorial entre o turno atual e os `trigger_cues` / resumo de origem da piada (permitindo reconhecer *"fui mexer numa biblioteca antiga e deu erro"* no Dia 18 como conectado ao *"fantasma no backend"* do Dia 1 sem repetir a palavra *"fantasma"*).
   - Quando a Ashy emite `<|CALLBACK:id|>`, `recordJokeCallback` ativa imediatamente um **`CooldownLock`** (mínimo de turnos e janela temporal antes de nova elegibilidade), impedindo repetição mecânica.

## Consequences

### Positivas
- **Zero memórias sem origem:** O usuário pode auditar de qual conversa nasceu cada fato, marco ou piada interna, e excluir qualquer item (removendo também entradas FTS5 e vetores).
- **Callbacks naturais e não-repetitivos:** Piadas internas emergem nos momentos semanticamente adequados e respeitam o período de descanso (`CooldownLock`).
- **Higiene do `[Context]`:** Memórias já visíveis na janela da conversa atual são filtradas de `compileTurnPrompt`, e episódios legados corrompidos/triviais são higienizados automaticamente no boot (`pruneCorruptedAndTrivialEpisodes`).

### Negativas / Trade-offs
- A consolidação pós-episódio (`Predict -> Calibrate` + geração de embeddings) exige chamadas assíncronas em background ou no ciclo do `DreamWorker`.

## Codebase References
- `packages/cortex/src/cortex.ts`
- `packages/cortex/src/hybrid-ranker.ts`
- `packages/cortex/src/fsrs-turn-loop.ts`
- `packages/cortex/src/inside-joke-engine.ts`
- `packages/cortex/src/episode-segmenter.ts`
- `packages/cortex/src/episode-extractor.ts`
- `packages/cortex/src/memory-extractor.ts`
- `packages/cortex/src/dream-worker.ts`
