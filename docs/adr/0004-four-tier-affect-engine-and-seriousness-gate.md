# ADR-0004: Motor Afetivo em 4 Escalas Temporais, `SeriousnessGate` Híbrido e Evolução Auditável/Reversível (*Dream & Reflection*)

- **Status:** Accepted
- **Date:** 2026-10-31
- **Milestone:** Fase 4 & Fase 8.3 — Emoções e Evolução Reais

---

## Context

Em muitos projetos de personagens virtuais, o "estado emocional" é apenas um rótulo trocado a cada mensagem, sem inércia emocional entre turnos, ou então uma deriva opaca em que a personagem muda de personalidade sem que o usuário saiba por quê ou consiga desfazer.

Além disso, uma personagem configurada para ser espirituosa e provocadora corre o risco grave de fazer piadas ou ironias quando o usuário está passando por um momento de luto, crise pessoal, pânico ou urgência real.

## Decision

1. **Vetor Afetivo em 4 Escalas Temporais (`affect-engine.ts`):**
   - Modelamos o estado afetivo da Ashy em quatro camadas com constantes de tempo distintas:
     1. **Pulso Imediato (*Immediate Pulse*):** Reação instantânea do turno atual disparada pelos marcadores `<|ACT:emotion=...,intensity=...|>` dentre os 13 estados emocionais canônicos;
     2. **Humor da Sessão (*Session Mood*):** Estado emocional com inércia e decaimento exponencial suave ao longo da conversa ativa;
     3. **Clima Afetivo (*Affective Climate*):** Tendência acumulada ao longo de dias/semanas de convivência;
     4. **Temperamento Base (*Baseline Temperament* — 5 Traços):** `warmth`, `playfulness`, `directness`, `curiosity` e `chaosEnergy`, com limites estritos de deriva máxima para preservar a identidade nuclear da Ashy.

2. **`SeriousnessGate` Híbrido de Prioridade Máxima:**
   - Antes de compilar o prompt de qualquer turno, o `SeriousnessGate` avalia a mensagem do usuário combinando:
     - **Piso Determinístico Ultrarrápido (Regex/Léxico Semântico):** Detecta indicadores imediatos de luto, crise, desespero, saúde, demissão ou pedido explícito de conversa séria;
     - **Classificação Contextual:** Mantém o gate aberto enquanto o tópico delicado persistir na janela recente.
   - Quando o `SeriousnessGate` é ativado:
     - `playfulness` e `chaosEnergy` efetivos são amortecidos no prompt;
     - Todas as piadas internas (`InsideJokeMotif`) são suprimidas daquele turno;
     - A UI exibe o indicador transparente `Por aqui, acolhendo você com calma.` (`seriousness-gate-badge`).

3. **Evolução Auditável e Reversível em 1 Clique (*Dream & Reflection*):**
   - Os 5 traços de temperamento nunca mudam arbitrariamente durante um turno comum. Eles só evoluem durante o ciclo de consolidação **`Dream & Reflection`** (`dream-worker.ts`), exigindo:
     - Episódios reais de origem (`source_episode_ids`);
     - Uma justificativa legível registrada em `personality_evolution_log` e no `DreamJournalEntry`;
     - Capacidade de **Reversão em 1 Clique (`revertPersonalityEvolution`)** na UI, que desfaz o delta exato e restaura o valor anterior do traço no `ashy.db`.

4. **Salvaguardas Éticas de Vínculo:**
   - Proibição explícita no prompt e nas avaliações M2 contra indução de culpa por ausência do usuário, cobrança de atenção ou simulação de dependência emocional tóxica.

## Consequences

### Positivas
- **Continuidade emocional crível:** O humor da Ashy não salta artificialmente do entusiasmo extremo à frieza em 1 segundo, exceto quando o `SeriousnessGate` exige acolhimento imediato.
- **Segurança emocional em momentos críticos:** Zero piadas internas ou sarcasmo quando o usuário relata dor ou urgência.
- **Controle total do usuário sobre a evolução:** Toda mudança de personalidade tem causa explícita e pode ser revertida com um único clique.

### Negativas / Trade-offs
- O `SeriousnessGate` prioriza evitar falsos negativos (nunca brincar em momento sério), podendo ocasionalmente adotar tom mais cuidadoso se o usuário usar metáforas dramáticas ambíguas.

## Codebase References
- `packages/cortex/src/affect-engine.ts`
- `packages/cortex/src/dream-worker.ts`
- `packages/cortex/src/soul-composer.ts`
- `packages/shared/src/index.ts`
- `apps/desktop/src/main/turn-orchestrator.ts`
