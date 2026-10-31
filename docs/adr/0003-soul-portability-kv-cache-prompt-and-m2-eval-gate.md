# ADR-0003: Portabilidade da Alma (`.ashy-soul`), Prompt Amigável a KV-Cache, Parser Tail-Safe e Gate de Avaliação M2

- **Status:** Accepted
- **Date:** 2026-10-31
- **Milestone:** M2 — Validação do Experimento Central & M5 — Release 1.0

---

## Context

O diferencial central da Ashy é que **sua identidade, seu estilo de fala e sua história compartilhada pertencem à companheira, e não a um modelo específico**. Na prática, trocar um LLM (por exemplo, de um modelo em nuvem para o `LFM3-Omni-2B` local ou do Claude para o GPT-4o/Qwen) costuma destruir a personalidade da assistente, reintroduzir clichês robóticos (*"Como uma IA, posso ajudar..."*) ou quebrar a extração de sinais de expressão durante o streaming SSE.

Além disso, o usuário precisa poder fazer backup completo da alma da Ashy, migrá-la entre computadores ou restaurá-la após um *Factory Reset* com garantia criptográfica de integridade.

## Decision

1. **Compositor de Prompt Amigável a KV-Cache (`soul-composer.ts`):**
   - Dividimos o prompt de cada turno em duas regiões estritamente ordenadas:
     - **Prefixo Estático (`buildStaticSoulSystemPrompt` — 100% cacheável no KV-Cache):** Contém a identidade nuclear da Ashy (`voice.md`), regras anti-slop, instruções de leitura silenciosa do bloco `[Context]` (`[INTERNAL CORTEX RECALL — HOW TO READ [Context]]`), contrato de marcadores `<|ACT|>`, `<|DELAY|>`, `<|CALLBACK|>` e os *Golden Dialogue Exemplars*.
     - **Sufixo Dinâmico Contextual:** Contém o estágio atual do relacionamento, vetor afetivo em 4 escalas, status do `SeriousnessGate`, memórias recuperadas pelo ranker híbrido FSRS-6, piadas internas fora de cooldown, intenções prospectivas e hábitos relevantes.

2. **Parser Incremental Tail-Safe (`marker-parser.ts`) e Ancoragem por Sentinela (`\uE000`):**
   - Criamos `createTailSafeMarkerParser` e `createCategorizer` em `@ashy/llm` para processar streams SSE token a token:
     - Qualquer sufixo parcial que possa ser o início de `<|ACT:...|>` ou `<think>` fica retido em um buffer de cauda até que o delimitador feche, garantindo **vazamento zero** de tags de controle na UI ou no sintetizador de voz.
     - No modo `native-omni`, combinamos a extração dual-channel com a tool `ashy_stage_signal` para que o modelo de áudio nativo dispare expressões sem pronunciar tags.

3. **Formato Portátil `.ashy-soul` com Verificação `SHA-256` e Valibot:**
   - Especificamos o pacote `.ashy-soul` (`soul-archive.ts`) contendo episódios, fatos semânticos, marcos autobiográficos, piadas internas, intenções, hábitos, estado afetivo e histórico de evolução, selado por um checksum canônico **`SHA-256`**.
   - A importação (`importSoulArchive`) valida integralmente o schema Valibot e o hash `SHA-256` em memória **antes** de executar a substituição transacional no SQLite (`BEGIN IMMEDIATE ... COMMIT`).

4. **Bateria Automatizada do Experimento Central (`@ashy/evals` — Gate M2):**
   - Institucionalizamos o pacote `packages/evals` (`pnpm eval:m2`), que executa roteiros multi-dia com troca de modelo A $\rightarrow$ B no meio da jornada, exigindo:
     - **Zero memórias alucinadas** (`hallucinatedMemories === 0`);
     - Preservação de recall de memórias e callbacks de piadas internas no momento certo;
     - Respeito estrito ao `SeriousnessGate` e ausência de clichês de assistente (anti-slop).

## Consequences

### Positivas
- **TTFT reduzido em modelos locais e em nuvem:** Como o prefixo estático nunca muda entre turnos consecutivos, servidores como `llama-server`, Ollama, Anthropic e OpenAI reutilizam o KV-Cache do prefixo instantaneamente.
- **Independência real de fornecedor:** O usuário troca de LLM na UI sem reiniciar o app e sem perder referências internas, tom ou humor.
- **Migração segura:** Arquivos `.ashy-soul` corrompidos ou adulterados são bloqueados antes de tocar no `ashy.db`.

### Negativas / Trade-offs
- Qualquer alteração no contrato de marcadores `<|ACT|>` exige atualização coordenada entre `soul-composer.ts`, `marker-parser.ts` e a suíte `@ashy/evals`.

## Codebase References
- `packages/cortex/src/soul-composer.ts`
- `packages/cortex/src/soul-archive.ts`
- `packages/llm/src/marker-parser.ts`
- `packages/llm/src/categorizer.ts`
- `packages/llm/src/anti-slop.ts`
- `packages/evals/src/m2-harness.ts`
- `scripts/run-m2-eval.mjs`
