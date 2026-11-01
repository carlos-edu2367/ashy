# Small-model conversation quality & context control (Live Mode, LFM3-Omni-2B)

Date: 2026-11-01. Machine: RTX 4060 8 GB (shared with other agents' Ollama runners during the runs, so
latencies below are pessimistic), managed llama.cpp b12024 + `LFM3-Omni-2B-Q4_K_M` over `/v1/realtime`.
Everything was measured with REAL runs; nothing left the machine.

## 1. The failure (real call, 2026-11-01)

Every reply of the user's call was `Olá, Carlos! Tudo bem. Como posso te ajudar hoje?` (later turns of the
same loop echoed the user verbatim). Root causes, all reproduced by the eval below:

1. **Memory poisoning, self-reinforcing.** Per-turn `[Contexto]` injected "Memórias relevantes" that were raw
   episode summaries `Usuário: Olá. | Ashy: Olá, Carlos! Tudo bem…` / `Usuário: O que você sabe fazer? | Ashy:
   O que você sabe fazer?`. They came from the voice-turn recorder (`indexTurnMemory`) and from the
   deterministic consolidation (`extractEpisodeDeterministic`), which paired the user with whatever Ashy said
   — including echoes and the greeting loop. The 2B model copies any sentence it sees → more bad memories.
2. **Rotation with a recap** that carried Ashy's own lines (fixed earlier tonight: no rotation on a single
   near-repeat, `rotateAfterTurns` 6 → 40 with settings migration, user-only recap, contextSize 16384).
3. **Prompt/format** (with a CLEAN store): the same `[Contexto] Hora local … Humor …` block on every turn,
   no explicit speaker roles. Realtime opened every reply with a greeting and called the user "Ashy"
   (mirroring "Oi, Ashy!"); hybrid echoed the user and, with the tools text line, sometimes read the whole
   input item back (`[Contexto] Hora local: … Carlos: Meu gato se chama Biscoito.`).

## 2. Eval harness (committed)

`node scripts/eval-live-conversation.mjs --userdata <copy of a userData dir> [--backend realtime|hybrid|both]
[--scenarios a,b] [--tools on|off|keep] [--out report.json] [--label x]` — and `--rescore report.json` to
re-score a saved run with the current scorer (all numbers below use the final scorer).

Per (backend, scenario): throw-away copy of the userData dir (DB/settings copied, engines/models junctioned;
the real `%APPDATA%\@ashy\desktop` is refused) → real host kernel → `call:start` (managed llama-server) →
session-level `call:buildContext` → the real `createLlamaCppRealtimeSession` / `createLlamaCppHybridSession`
→ per turn `call:buildContext` (memory retrieval, mood, time) + `formatTranscribedUserTurn` (exactly what the
CallEngine submits) → reply → the real `call:recordTurn` (persist + indexing, so later turns see what
indexing produced). Mic/VAD/STT are skipped (text given), hybrid TTS is stubbed (text is scored), the
CallEngine's rotation is not exercised (unit-tested instead).

Scenarios (`packages/evals/src/live-call/scenarios.ts`, pt-BR): the user's exact failing sequence; the same
on a store seeded with the looped legacy summaries (`poisoned-store`); small talk; factual questions; recall
of a fact said earlier in the call; recall from a previous call (seeded through the real recorder); a
15-turn conversation with late recall; a barge-in follow-up (`[Sua fala anterior foi interrompida…]`).

Scorer (`scoring.ts`): `echo` (reply parrots the utterance: identical, starts with it, first sentence ≥ 0.8
similar, or utterance + fillers only — an answer that restates the question is NOT an echo), `repeat`
(near-identical to an earlier reply, or the same tail sentence), `greet` (greeting opener after turn 1 when
the user did not greet), `name` (calls the user "Ashy" / speaks as the user), `leak` (`[Contexto]`, tags),
`topic` (expected keywords; a greeting/"como posso ajudar" never counts), `recall`, `long`, `empty`, language.

## 3. Results (turns passing all checks)

Tools ON (the user's real settings), clean store with the user's name fact, 98 turns per run:

| run | realtime | hybrid | total |
|---|---|---|---|
| before (code before this work, incl. the earlier rotation fix) | 27/49 | 15/49 | **42/98 (43 %)** |
| after, run 1 | 39/49 | 42/49 | **81/98 (83 %)** |
| after, run 2 (final committed code) | 36/49 | 45/49 (92 %) | **81/98 (83 %)** |

User's real (poisoned) DB copy, failing sequence + in-call recall (22 turns):

| run | realtime | hybrid | total |
|---|---|---|---|
| before | 3/11 | 8/11 | **11/22 (50 %)** |
| after, run 1 | 8/11 | 10/11 | **18/22 (82 %)** |
| after, run 2 | 8/11 | 11/11 | **19/22 (86 %)** |

Run 2 on the user DB also covered small talk and cross-call recall: cross-call recall 2/2 on both
backends; realtime small talk only 1/6 (see §5 — it injected a same-call statement as a "memory" on every
turn, fixed afterwards by the relevance rule, see the follow-up run below).

Per scenario (after run 2, clean, realtime / hybrid): failing sequence 80 % / 100 % (before 20 % / 80 %);
poisoned store 80 % / 100 % (before 20 % / 20 %); small talk 67 % / 100 % (before 0 % / 67 %); in-call recall
2/2 + 2/2 (before hybrid 0/2: it read the whole input item back); cross-call recall 2/2 + 2/2; long-15
73 % / 80 % with both late recalls right on both (before hybrid 0 %: echo + "Ashy" on 13 turns);
interruption 75 % / 100 %. Zero context leaks, zero greeting-again on hybrid.

Full audio path (scratch e2e: TTS-synthesized questions → fake mic → Silero VAD → Ollama STT → CallEngine →
hybrid session with the guard → /tts with the reference voice), user's poisoned DB, the exact failing
sequence: "Olá, Carlos! Tudo bem?" / "Entendi, Carlos. O que você quer falar?" / a real list of
capabilities / "O que exatamente você está tentando resolver?" / a space fact (Andrômeda a 2,5 milhões de
anos-luz) — no loop, no echo, mouth-to-ear ~2 s.

Prompt-variant sweep (hybrid, tools on, 41 turns, 2 samples each): base prompt 21/21; + speaker roles,
"greet only once", "never repeat the user's words" 30–37; removing the per-turn time/mood block or the
`Carlos:` label moved results by only ±2 (inside sampling noise), so the label (protocol contract) stays.
The `Respond in interleaved text and audio.` line with text-only output was not better than the text line
once the prompt was fixed (29–35 vs 32–37), so hybrid keeps the text mode line.

Realtime sweep (32 turns: failing sequence, small talk, in-call recall, long-15): production prompt 24/32;
+ "never restate or summarize what Carlos said, never speak as Carlos" 24/32 (fewer echoes, more greetings);
+ a per-turn nudge `[Contexto] … não cumprimente e não repita …` **20/32** (more read-back echoes) —
every extra per-turn line is something the 2B model repeats, so neither was adopted.

Follow-up run after the memory relevance rule (a past statement sharing no word with the utterance is
never injected): user DB small talk / in-call / cross-call recall 25/30 (realtime 11/15 — in-call recall
50 % → 83 %, small-talk repeats 3 → 0 — hybrid 15/15); clean small talk + long-15 36/42 (realtime small
talk 100 %, long-15 73 %; hybrid 100 % / 87 %, all late recalls right).

## 4. What changed

Context control (host + cortex):
- `apps/desktop/src/host/live-call/call-memory.ts` — `selectCallMemoryLines`: memories in a call are only
  (1) semantic facts about the user touched by the utterance (name/pronouns excluded; they are in the
  instructions), rendered in pt-BR ("gato de Carlos se chama Biscoito"), and (2) the user's own past
  statements ("Carlos contou: …"), never Ashy's wording. Dropped: greetings/trivia (`hasMemorableContent`),
  questions/requests, placeholders, near-duplicates, lines (almost) identical to the current utterance.
  A past statement that shares no word with the utterance is not injected (vector retrieval always returns
  something; an unrelated memory on every turn made the model drag one topic into every reply).
  Max 3 lines / 360 chars. Non-destructive: poisoned rows stay in the store, they are filtered at retrieval.
  Only episodes that made it into the context are FSRS-reviewed.
- `recorder.ts` — the chat keeps what Ashy said, but the memory pipeline gets Ashy's reply only when worth
  remembering (`memoryWorthyAssistantText`: no echo, greeting-only reply or near-repeat of the call →
  user side only). Placeholder transcripts never reach affect/memory.
- `packages/cortex` — `conversation-hygiene.ts` (similarity, echo, greeting, placeholder, user-side
  extraction, `isPoisonedTranscriptMemory` — legacy junk pairings skipped in the composed prompt for text
  chat too, never deleted); `indexTurnMemory` writes user-only summaries when told to and never indexes placeholders,
  and extracts personal facts (`named:<relation>` — pets/family —, `lives_in`, `likes:<thing>`) so
  "meu gato se chama Biscoito" becomes a fact even though the sentence is "trivial";
  `extractEpisodeDeterministic` no longer pairs/keeps echo or greeting-only replies.
- `context.ts` — instructions name the roles ("You are Ashy, Carlos's AI companion… Each user message is
  what Carlos just said… never call Carlos "Ashy""), "Greet only once…", "Never repeat Carlos's words back…";
  time/mood only on the first turn of a chat session, on mood change or every 10 min.

Engine / sessions (`packages/voice`):
- Hybrid conversation guard (default on): the reply is held until its first sentence is complete
  (~100–200 ms); an opening that repeats the utterance is cut before TTS; a reply that is only the echo is
  regenerated once with a private nudge; "Ashy" said to the user is removed from what is spoken/reported.
- CallEngine loop self-heal: one near-repeat is only logged; two CONSECUTIVE near-repeats rotate the session
  (safe now: the recap carries only the user's topics and says "não cumprimente de novo").

## 5. Remaining limits

- Realtime keeps the template of its first reply: after "Oi Ashy, tudo bem?" → "Oi Carlos, tudo bem?" it
  opened the next replies with "Oi Carlos," (user DB small talk 2/6). The loop self-heal only fires on
  near-repeats, not on a repeated opener. Hybrid does not show it. For a small model, hybrid is the
  recommended local backend.
- Realtime (text+audio) cannot be filtered after the fact (the audio is generated with the text), so its
  echo/"Ashy" mirroring is only reduced by the prompt; it still restates short statements ("Meu gato se
  chama Biscoito, hein?") and sometimes uses "hein?" as a tic. Hybrid is the more controllable backend.
- World knowledge of a 2B model: "a capital da Austrália é Sydney", arithmetic slips. Not a context issue.
- Recall inside a call relies on the realtime session history (verified over 15 turns) plus the indexed
  user statements; across calls on facts + user statements (2/2 on both backends). No rolling summary was
  added: memories already cover cross-call continuity, and every extra context line is something the 2B
  model may copy.
- The eval skips mic/VAD/STT and the CallEngine; STT errors and rotation are covered by unit tests and the
  scratch e2e harness, not by the scores above.
