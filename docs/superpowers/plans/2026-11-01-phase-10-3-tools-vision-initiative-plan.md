# Phase 10.3: ferramentas, visão e iniciativa na chamada

> **Spec:** `docs/superpowers/specs/2026-10-31-phase-10-live-call-engine-design.md` (§7.5–7.7, §8.2; §11 linha 10.3).
>
> **Contrato** (`packages/shared/src/live-call-protocol.ts`, adições da 10.3 já escritas):
> - **Tipos:** `CallContextResult.tools/toolChoice/approvalHandled`, `CallToolDefinition`, `CallExecuteToolResult`, `CallCheckInitiativeResult`, `AgencyPendingCardView`.
> - **Comando:** `CallCommand` `inject`.
> - **Métodos:** `call:executeTool`, `call:checkInitiative`, `agency:approve`, `agency:deny`.
> - **Eventos:** `agency:pending`, `agency:resolved`, `vision:capture`.
>
> **Base:** commit `c46223f`.

## Spike real (2026-11-01, RTX 4060, llama-server b12024, LFM3-Omni)
Script: `scratchpad/spike-tools-vision.ts`.

**Formato de instructions que funciona com tools:** persona em EN, depois `Always respond in Brazilian Portuguese…`, e por último `Respond with function calls, and interleaved text and audio.\n\nList of tools:`. Nesse formato:
- "que janela eu tô usando?" chamou `get_active_window_title()`;
- "lê o arquivo notas.txt" chamou `read_workspace_file({"path":"notas.txt"})`;
- em seguida ela respondeu usando o resultado.

**Problema 1: chama tools sem precisar.** Na conversa fiada (piada), ela chamou 2 tools. Solução: `toolChoice` por turno, decidido no host (heurística de intenção em PT). `response.create {response:{tool_choice:'none'}}` funciona.

**Problema 2: modo áudio não chama tools.** Com `output_modalities:["text","audio"]`, **nenhuma** tool é chamada. Solução: **duas etapas**.
1. Turno com intenção: `response.create {tool_choice:'auto', output_modalities:['text']}`, que devolve a function call.
2. O host executa e o resultado volta como `conversation.item.create {type:'function_call_output', call_id, output}`.
3. A fala sai com `response.create {tool_choice:'none', output_modalities:['text','audio']}`.

Com isso: 4/4 casos corretos, com resposta falada usando o resultado, e a piada sem tool.

**Visão:** `POST /v1/chat/completions` no mesmo llama-server, com `image_url` (PNG base64) e o prompt "Descreva em uma frase curta, em português, o que aparece nesta tela." Leva **1,4 s** e a descrição é fiel.

## Escopo
1. **Tools na chamada** (`features.toolsInCall`, `caps.toolCalls`).
   - **Conjunto enxuto para o LFM3:** `get_active_window_title`, `capture_authorized_screen` (a visão real abaixo), `read_workspace_file` e `write_project_note` (staged).
   - Executadas pelo **gatekeeper existente** via `call:executeTool`.
   - Resultado `staged`: o output volta como `{"status":"aguardando_aprovacao","resumo":"…"}` e ela pede permissão.
   - Até 3 rodadas de tool por turno.
   - Se a etapa só-texto terminar **sem** tool call, o texto dela é falado via `host.synthesize` (o `/tts` da 10.2), sem segunda geração.
2. **Aprovações.**
   - Eventos push `agency:pending` e `agency:resolved`, válidos **também fora da chamada**. Hoje os cards só chegam via snapshot.
   - **Aprovação por voz**, só em cards `voiceApprovable` (nunca os com `blastRadiusWarning`). Quando há card pendente da chamada, o `call:buildContext` com `userText` checa frases determinísticas:
     - aprovar: "pode", "pode fazer", "sim, pode", "aprovado", "autorizo", "pode sim", "manda ver";
     - negar: "não", "cancela", "não pode", "deixa", "negado".

     Nesses casos aprova ou nega no gatekeeper e devolve `approvalHandled:true`, com o `perTurnContext` informando o resultado (`[Contexto] O usuário aprovou "<resumo>". Resultado: …`).
   - **O modelo nunca aprova.** Não existe tool de aprovação.
   - **Aprovação por clique** (`agency:approve`/`agency:deny`) com a chamada em `listening`: o host emite `call:command inject {reason:'approval'}` e ela fala do resultado.
3. **Visão real.**
   - **`ScreenCaptureProvider` no main:** `desktopCapturer.getSources`.
     - `eyesMode=screen`: tela principal.
     - `eyesMode=window`: janela em foco (casar pelo título da janela ativa; se não achar, recusar).
     - `eyesMode=off`: recusar.
     - Thumbnail de 1280×720 em PNG.
   - Registrado com `kernel.setScreenCaptureProvider`.
   - O host emite `vision:capture {active:true}` antes e `{active:false}` depois. A UI mostra "👁 vendo a tela".
   - **`VisionDescriber`:** llama-server `/v1/chat/completions` com a imagem, os headers do engine, timeout de 8 s, e cache por dHash do frame durante 30 s.
   - `capture_authorized_screen` passa a usar isso **na chamada**. No chat de texto, continua o comportamento atual, a menos que a troca seja trivial (o provider vale para os dois, mas não mexer no fluxo do chat além disso).
   - **Intenção visual sem tools:** se `toolsInCall` estiver off mas `visionInCall` on e a fala tiver intenção visual ("tela", "olha", "vê isso", "o que aparece"), o `buildContext` descreve a tela e injeta `[Tela] …` no `perTurnContext`.
4. **Iniciativa.**
   - **Gatilho:** em `listening`, depois de `idleNudgeSec` sem fala (padrão 90 s), o engine chama `call:checkInitiative`.
   - **Decisão no host:**
     - usa `evaluateAttentionInitiative` (motor existente), respeitando DND, quiet hours, cooldown e teto diário;
     - acrescenta um cooldown só da chamada: no máximo 1 iniciativa a cada 10 min;
     - não fala se estiver mutado.
   - **Se falar:** `{speak:true, contextText:'[Contexto] (Iniciativa) Puxe assunto de forma natural sobre: <motivo>'}`, e o engine faz `inject`.
   - **`[SILENCE]` ou recusa:** nada acontece. O timer reinicia.

## Tarefas (paralelas)

### T1: engine e boot — `packages/voice/src/call/**`, `apps/desktop/src/call-engine/boot.ts`
- **Sessão:** `connect` envia `tools` e `tool_choice:'auto'` no `session.update` quando `buildContext()` inicial trouxer tools. As instructions já vêm prontas do host.
- **`submitUserText`** aceita opções `{ toolChoice }`.
  - **`'none'`:** `response.create {response:{tool_choice:'none'}}`.
  - **`'auto'`, as duas etapas:**
    1. `response.create {response:{tool_choice:'auto', output_modalities:['text']}}`;
    2. coleta as function calls (`response.output_item.added` com `item.type==='function_call'` + `response.function_call_arguments.done`);
    3. no `response.done`, chama `host.executeTool` para cada uma, envia os `function_call_output` e faz `response.create {response:{tool_choice:'none', output_modalities: <modo da sessão>}}`, com até 3 rodadas;
    4. sem tool calls, sintetiza o texto via `host.synthesize` e toca.
- **Eventos novos da sessão:** `tool_call`, `tool_step_started` e `tool_step_done`. A legenda mostra "🔧 usando <ferramenta>…".
- **Híbrido:** mesma lógica, sempre em modo texto e com o TTS por frase.
- **`engine.inject(contextText, reason)`:**
  - só em `listening`; se a chamada estiver ocupada, entra numa fila de 1 item e expira em 30 s;
  - envia `conversation.item.create input_text` com o contexto e depois `response.create`;
  - o ledger grava o turno com `userTranscript:''`; o recorder já trata isso como placeholder; use `[iniciativa]` ou `[aprovação]` como marcador **no meta**, não no conteúdo.
- **Iniciativa:** um timer de silêncio em `listening` (reinicia em qualquer fala ou resposta) chama `host.checkInitiative`, e se vier `speak`, faz `inject`. Só roda com `features.initiativeInCall`.
- **`CallEngineHost`** ganha:
  - `executeTool(input): Promise<CallExecuteToolResult>`
  - `checkInitiative(input): Promise<CallCheckInitiativeResult>`
- **`boot.ts`:** trata `command:'inject'` (só para o callId ativo) e implementa os dois métodos novos no adaptador.
- **Testes:** `packages/voice/test/voice-phase10-3-*.test.ts` com o servidor fake, cobrindo:
  - a sequência das duas etapas (a ordem exata dos eventos);
  - `tool_choice:'none'` em conversa fiada;
  - o fallback de synthesize sem tool call;
  - o limite de 3 rodadas;
  - `inject` com fila e expiração;
  - o timer de iniciativa;
  - o híbrido com tool.

### T2: host — `apps/desktop/src/host/live-call/{tools,approvals,vision,initiative}.ts` (novos) + `context.ts`/`handlers.ts`/`call-hub.ts`, `apps/desktop/src/host/agency-runtime.ts` (eventos push), `kernel.ts` (≤ 4 linhas)
- **`tools.ts`:**
  - definições das 4 tools em JSON Schema, convertidas a partir das tools existentes (`buildAgencyChatTools` em `turn-orchestrator.ts`, `valibotSchemaToJsonSchema`), com descrições curtas em EN;
  - `call:executeTool` com o `executeGatekeptMcpTool`/agency runtime existente, mapeando para `CallExecuteToolResult`;
  - output truncado em 2000 chars;
  - `capture_authorized_screen` passa pelo `VisionDescriber`.
- **`context.ts`:**
  - quando `features.toolsInCall` está ativo, a última linha das instructions vira `Respond with function calls, and interleaved text and audio.\n\nList of tools:` (no modo realtime) ou `Respond with function calls, and text.\n\nList of tools:` (no híbrido), e o resultado devolve `tools`;
  - por turno: `toolChoice` = `'auto'` se a heurística de intenção PT casar com `\b(janela|tela|arquivo|nota|anota|lê|ler|abre|abrir|olha|vê|procura|pesquisa|salva)\b` (afinar com os testes), senão `'none'`;
  - aprovação por voz (ver o escopo);
  - intenção visual sem tools vira o contexto `[Tela]`.
- **`approvals.ts`:**
  - o agency runtime passa a emitir `agency:pending` (com `AgencyPendingCardView`, `voiceApprovable = !blastRadiusWarning && riskTier==='staged-confirm'`, e o callId quando veio de uma chamada) e `agency:resolved`;
  - handlers `agency:approve`/`agency:deny` reaproveitam `approvePendingAction`/`denyPendingAction`;
  - quando o card é de uma chamada ativa, emite `call:command inject {reason:'approval', contextText:'[Contexto] Ação aprovada: <resumo>. Resultado: <output curto>'}`; para negação, um texto equivalente.
- **`vision.ts`:**
  - interface `ScreenCaptureProvider { capture(mode: 'screen'|'window', activeWindowTitle?: string): Promise<{ pngBase64: string; source: 'screen'|'window' } | null> }`;
  - `kernel.setScreenCaptureProvider(p | null)`;
  - `VisionDescriber`: chat completions no llama-server com os headers do engine, timeout de 8 s, cache por hash dos bytes durante 30 s;
  - emite `vision:capture`;
  - respeita o `eyesMode` e o consentimento do privacy controller existente (descobrir onde vive);
  - se o engine não estiver rodando ou não houver provider, retorna "visão indisponível".
- **`initiative.ts`:**
  - `call:checkInitiative` chama `evaluateAttentionInitiative` (kernel) com `idleMinutes`, `localTimeHHMM` e a última fala do usuário da chamada;
  - aplica o cooldown de 10 min da chamada;
  - respeita mute, DND e `features.initiativeInCall`.
- **Testes:** `apps/desktop/src/__tests__/phase-10-3-call-host-tools.test.ts`, cobrindo:
  - instructions e tools por modo;
  - a heurística de intenção (inclui "me conta uma piada" → `none`);
  - `executeTool` executed, staged e blocked;
  - aprovação por voz (sim/não, card com blast radius ignorado);
  - `agency:approve` gerando `inject`;
  - os eventos `agency:pending`/`agency:resolved`;
  - visão (provider fake, `eyesMode` off recusa, cache, timeout);
  - iniciativa (cooldown, mute, DND).

### T3: main + UI — `apps/desktop/src/main/index.ts`, `apps/desktop/src/store/useCallStore.ts`, `apps/desktop/src/components/LiveCallControls.tsx`, `App.tsx` (balão e indicador), `styles.css`
- **Main:**
  - implementar o `ScreenCaptureProvider` com `desktopCapturer.getSources({types:['screen'|'window'], thumbnailSize:{width:1280,height:720}})`, escolhendo a tela principal ou a janela cujo nome bate com o título ativo;
  - devolver `toPNG().toString('base64')`;
  - registrar com `kernel.setScreenCaptureProvider`;
  - excluir as próprias janelas da Ashy da captura de janela.
- **Store:**
  - assina `agency:pending`/`agency:resolved` (lista de cards pendentes, válida também fora da chamada);
  - assina `vision:capture` (flag `capturingScreen`, com auto-off em 5 s);
  - ações `approveCard` e `denyCard` → `agency:approve|deny`.
- **UI:**
  - card de aprovação **push** no hub (faixa da chamada) e no balão do overlay (o `stage-pending-action-bubble` já existe; alimentar pelo push além do snapshot), com Aprovar/Negar e o texto "ou diga 'pode' / 'não'" quando `voiceApprovable` e houver chamada ativa;
  - indicador "👁 vendo a tela" no hub e no overlay enquanto `capturingScreen`;
  - **Live Mode › Recursos na chamada:** toggles Ferramentas, Visão e Iniciativa (com o intervalo em segundos);
  - aviso: "As ferramentas usam o modelo local de 2B; funciona melhor para pedidos simples."
- **Testes:** `apps/desktop/src/__tests__/phase-10-3-call-ui-vision.test.tsx`, cobrindo:
  - o provider escolhendo a fonte (desktopCapturer mockado) e excluindo as janelas da Ashy;
  - o card push aparecendo e aprovando ou negando;
  - o indicador de visão;
  - os toggles salvando as settings.

## Integração
1. `pnpm typecheck`, `pnpm test` e `pnpm build`.
2. **E2e real** (`scratchpad/e2e-call.ts`), com `toolsInCall` e `visionInCall` ligados:
   - pergunta falada "Ashy, que janela eu tô usando?" (gerada pelo `/tts`);
   - "Olha minha tela" (com provider fake carregando `uploads/image.png`);
   - "anota que amanhã tem reunião", que gera um card staged; em seguida "pode" aprova por voz;
   - iniciativa com `idleNudgeSec` curto.
3. Commit + push. O Carlos faz `git pull` + install.
