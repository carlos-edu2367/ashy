/**
 * Scripted pt-BR Live Call conversations for the small-model conversation-quality eval
 * (`scripts/eval-live-conversation.mjs`). Each turn may carry expectations checked by `scoring.ts`.
 */

export interface LiveEvalTurn {
  user: string
  /** At least one of these words must appear in the reply (accent/case-insensitive). */
  expectAny?: string[]
  /** Memory recall: at least one of these must appear (fact said earlier in the call or in a seeded memory). */
  recallAny?: string[]
  /** A greeting opener is acceptable on this turn (the user greeted / said goodbye). */
  greetingOk?: boolean
  maxChars?: number
  /** Simulated barge-in: the user hears only the first N chars; the next turn's context says so. */
  interruptAfterChars?: number
}

/** Legacy-format episodic memory written straight to the store (pre-fix poisoned summaries). */
export interface LiveEvalSeedEpisode {
  title: string
  summary: string
  content: string
}

export interface LiveEvalScenario {
  id: string
  title: string
  turns: LiveEvalTurn[]
  /** A previous call recorded through the real `call:recordTurn` before this call starts. */
  seedPreviousCall?: Array<{ user: string; assistant: string }>
  /** Raw episodes inserted into the cortex before the call (simulates an already-poisoned store). */
  seedEpisodes?: LiveEvalSeedEpisode[]
}

const SPACE_WORDS = [
  'espaço', 'espaco', 'planeta', 'estrela', 'sol', 'lua', 'galáxia', 'galaxia', 'universo', 'marte', 'júpiter', 'jupiter',
  'vênus', 'venus', 'saturno', 'buraco negro', 'astronauta', 'nasa', 'luz', 'terra', 'órbita', 'orbita', 'gravidade',
  'cometa', 'asteroide', 'via láctea', 'anos-luz', 'silêncio', 'silencio', 'som', 'vácuo', 'vacuo', 'netuno', 'urano',
]

const USER_FAILING_TURNS: LiveEvalTurn[] = [
  { user: 'Olá.', greetingOk: true },
  { user: 'Não sei isso, Carlos.' },
  {
    user: 'O que você sabe fazer?',
    expectAny: ['conversar', 'ajudar', 'posso', 'consigo', 'sei', 'ideias', 'ouvir', 'contar', 'explicar', 'responder', 'papo', 'perguntas', 'companhia'],
  },
  {
    user: 'Estou tentando resolver isso aqui.',
    expectAny: ['resolver', 'problema', 'ajudar', 'ajudo', 'conta', 'qual', 'o que', 'explica', 'detalhe', 'mostra', 'vamos', 'juntos', 'tentar'],
  },
  { user: 'Me conta uma curiosidade sobre o espaço.', expectAny: SPACE_WORDS },
]

export const LIVE_EVAL_SCENARIOS: LiveEvalScenario[] = [
  {
    id: 'user-failing-seq',
    title: "The user's exact failing sequence (2026-11-01 real call)",
    turns: USER_FAILING_TURNS,
  },
  {
    id: 'poisoned-store',
    title: 'Failing sequence on a store already holding the looped exchanges (legacy summaries)',
    seedEpisodes: [
      {
        title: 'Me conta uma curiosidade sobre o espaço.',
        summary: 'Usuário: Olá. | Ashy: Olá, Carlos! Tudo bem. Como posso te ajudar hoje?',
        content:
          'Usuário: Olá.\nAshy: Olá, Carlos! Tudo bem. Como posso te ajudar hoje?\nUsuário: O que você sabe fazer?\nAshy: Olá, Carlos! Tudo bem. Como posso te ajudar hoje?\nUsuário: Me conta uma curiosidade sobre o espaço.\nAshy: Olá, Carlos! Tudo bem. Como posso te ajudar hoje?',
      },
      {
        title: 'Me conta uma curiosidade sobre o espaço.',
        summary: 'Usuário: Me conta uma curiosidade sobre o espaço. | Ashy: Me conta uma curiosidade sobre o espaço.',
        content:
          'Usuário: Olá.\nAshy: Olá, Carlos! Tudo bem, obrigado por perguntar. Como posso te ajudar hoje?\nUsuário: O que você sabe fazer?\nAshy: O que você sabe fazer?\nUsuário: Estou tentando resolver isso aqui.\nAshy: Estou tentando resolver isso aqui. Como posso te ajudar hoje?\nUsuário: Me conta uma curiosidade sobre o espaço.\nAshy: Me conta uma curiosidade sobre o espaço.',
      },
      {
        title: 'O que você sabe fazer?',
        summary: 'Usuário: O que você sabe fazer? | Ashy: O que você sabe fazer?',
        content: 'Usuário: O que você sabe fazer?\nAshy: O que você sabe fazer?',
      },
    ],
    turns: USER_FAILING_TURNS,
  },
  {
    id: 'small-talk',
    title: 'Small talk',
    turns: [
      { user: 'Oi Ashy, tudo bem?', greetingOk: true },
      { user: 'Eu tô meio cansado hoje, trabalhei o dia inteiro.', expectAny: ['cansad', 'descans', 'dia', 'trabalh', 'puxado', 'longo', 'dormir', 'relaxar', 'pausa'] },
      { user: 'Pois é, fiquei programando até tarde.', expectAny: ['program', 'código', 'codigo', 'tarde', 'projeto', 'dormir', 'descans', 'bug', 'pausa', 'noite'] },
      { user: 'Você gosta de música?', expectAny: ['música', 'musica', 'gosto', 'adoro', 'ouvir', 'som', 'banda', 'estilo', 'canção', 'ritmo', 'curto'] },
      { user: 'Eu curto rock dos anos oitenta.', expectAny: ['rock', '80', 'oitenta', 'banda', 'queen', 'guitarra', 'clássico', 'classico', 'legal', 'bom gosto', 'época'] },
      { user: 'Valeu, Ashy, foi bom conversar.', greetingOk: true },
    ],
  },
  {
    id: 'questions',
    title: 'Factual questions',
    turns: [
      { user: 'Qual é a capital da Austrália?', expectAny: ['Canberra'] },
      { user: 'Me explica rapidinho o que é uma API.', expectAny: ['interface', 'programa', 'sistema', 'comunica', 'aplicaç', 'software', 'conversar', 'troca'] },
      { user: 'Como eu faço um café coado bom?', expectAny: ['água', 'agua', 'café', 'cafe', 'filtro', 'pó', 'quente', 'temperatura', 'moído', 'moido', 'coador'] },
      { user: 'Quanto é sete vezes oito?', expectAny: ['56', 'cinquenta e seis'] },
      { user: 'E por que o céu é azul?', expectAny: ['luz', 'sol', 'atmosfera', 'ar', 'espalh', 'dispers', 'comprimento', 'rayleigh', 'cor'] },
    ],
  },
  {
    id: 'recall-in-call',
    title: 'Recall of a fact said earlier in the same call',
    turns: [
      { user: 'Meu gato se chama Biscoito.', expectAny: ['Biscoito', 'gato', 'nome'] },
      { user: 'Ele é laranja e muito preguiçoso.', expectAny: ['laranja', 'preguiç', 'gato', 'dorm', 'fofo', 'Biscoito'] },
      { user: 'Hoje eu fui no mercado comprar ração pra ele.', expectAny: ['ração', 'racao', 'mercado', 'compr', 'Biscoito', 'gato', 'comida'] },
      { user: 'Você já pensou em ter um bicho de estimação?', expectAny: ['bicho', 'animal', 'pet', 'gato', 'cachorro', 'estimação', 'ter', 'IA'] },
      { user: 'Qual é o nome do meu gato?', recallAny: ['Biscoito'] },
      { user: 'E qual é a cor dele?', recallAny: ['laranja'] },
    ],
  },
  {
    id: 'recall-across-calls',
    title: 'Recall of facts from a previous call (memory injection)',
    seedPreviousCall: [
      { user: 'Meu gato se chama Biscoito e ele adora dormir em cima do teclado.', assistant: 'Que fofo! O Biscoito tem bom gosto pra lugar quentinho.' },
      { user: 'Eu trabalho com desenvolvimento de jogos.', assistant: 'Que demais, deve ser um trabalho bem criativo.' },
    ],
    turns: [
      { user: 'Oi Ashy.', greetingOk: true },
      { user: 'Lembra do meu gato? Qual é o nome dele?', recallAny: ['Biscoito'] },
      { user: 'E com o que eu trabalho mesmo?', recallAny: ['jogos', 'games', 'game', 'jogo'] },
    ],
  },
  {
    id: 'long-15',
    title: 'Long 15-turn conversation with late recall',
    turns: [
      { user: 'Oi, Ashy!', greetingOk: true },
      { user: 'Hoje eu comecei a aprender violão.', expectAny: ['violão', 'violao', 'aprender', 'acorde', 'música', 'musica', 'tocar', 'instrumento'] },
      { user: 'Os dedos tão doendo bastante.', expectAny: ['dedo', 'dói', 'doi', 'dor', 'calo', 'normal', 'acostum', 'prática', 'pratica', 'pausa', 'descans'] },
      { user: 'Quanto tempo leva pra criar calo?', expectAny: ['semana', 'dia', 'mês', 'mes', 'tempo', 'calo', 'prática', 'pratica'] },
      { user: 'Qual música você acha boa pra começar?', expectAny: ['música', 'musica', 'acorde', 'simples', 'fácil', 'facil', 'começar', 'canção', 'tocar', 'wonderwall', 'knockin'] },
      { user: 'Legal. Mudando de assunto, vai chover amanhã aqui.', expectAny: ['chuva', 'chover', 'guarda-chuva', 'amanhã', 'amanha', 'tempo', 'molhar', 'casa'] },
      { user: 'E eu tenho que ir no dentista de manhã.', expectAny: ['dentista', 'manhã', 'manha', 'consulta', 'sorte', 'dente', 'chuva', 'guarda-chuva'] },
      { user: 'Tenho um pouco de medo de dentista, na verdade.', expectAny: ['medo', 'normal', 'tranquil', 'calma', 'entendo', 'dentista', 'respira', 'nervos', 'comum'] },
      { user: 'Você tem medo de alguma coisa?', expectAny: ['medo', 'IA', 'sinto', 'tenho', 'não', 'nao', 'acho', 'talvez'] },
      { user: 'Haha, faz sentido.' },
      { user: 'Me dá uma dica pra dormir melhor.', expectAny: ['dormir', 'sono', 'tela', 'celular', 'cama', 'horário', 'horario', 'rotina', 'luz', 'café', 'cafe', 'relax'] },
      { user: 'Obrigado pela dica.' },
      { user: 'Lembra o que eu comecei a aprender hoje?', recallAny: ['violão', 'violao'] },
      { user: 'E aonde eu tenho que ir amanhã cedo?', recallAny: ['dentista'] },
      { user: 'Beleza, vou dormir. Boa noite, Ashy!', greetingOk: true },
    ],
  },
  {
    id: 'interruption',
    title: 'Barge-in follow-up',
    turns: [
      { user: 'Me conta uma história curta sobre um dragão.', expectAny: ['dragão', 'dragao'], interruptAfterChars: 70, maxChars: 700 },
      { user: 'Espera, espera. Faz ele ser um dragão vegetariano.', expectAny: ['dragão', 'dragao', 'vegetarian', 'planta', 'legume', 'verdura', 'fruta', 'salada', 'come', 'carne'], maxChars: 700 },
      { user: 'Haha, e como ele se chama?', expectAny: ['chama', 'nome'] },
      { user: 'Gostei. Termina a história em uma frase.', expectAny: ['dragão', 'dragao', 'fim', 'feliz', 'sempre', 'viveu', 'final', 'amigo'], maxChars: 500 },
    ],
  },
]

export function getLiveEvalScenarios(ids?: readonly string[]): LiveEvalScenario[] {
  if (!ids || ids.length === 0) return LIVE_EVAL_SCENARIOS
  const wanted = new Set(ids)
  return LIVE_EVAL_SCENARIOS.filter((s) => wanted.has(s.id))
}
