import { Leaderboard, LeaderboardEntry, Question } from '../models';

/**
 * The competition demo's game, played entirely in the browser: the visitor
 * against a handful of made-up players. Scored and ranked by the same rules as
 * the server (`service.answer_points`, `service.leaderboard`), so what the demo
 * shows is what a real competition does.
 */

export const DEMO_MAX_POINTS = 1000;
export const DEMO_MIN_POINTS = 500;

/** A made-up player: how often they are right and how quick they are. */
export interface Bot {
  nickname: string;
  skill: number;
  /** 0 = answers at once, 1 = takes the whole clock. */
  pace: number;
}

export const BOTS: Bot[] = [
  { nickname: 'AlphaFolder', skill: 0.9, pace: 0.35 },
  { nickname: 'BLASToff', skill: 0.75, pace: 0.2 },
  { nickname: 'Helix Hannah', skill: 0.8, pace: 0.5 },
  { nickname: 'K-mer King', skill: 0.6, pace: 0.15 },
  { nickname: 'Ribosome', skill: 0.7, pace: 0.6 },
  { nickname: 'SeqSeeker', skill: 0.55, pace: 0.3 },
  { nickname: 'PhyloFan', skill: 0.65, pace: 0.7 },
  { nickname: 'Codon Crew', skill: 0.5, pace: 0.45 },
];

function q(id: number, text: string, options: string[]): Question {
  return {
    id,
    position: id - 1,
    text,
    text_html: `<p>${text}</p>`,
    image_url: null,
    kind: 'choice',
    mode: 'once',
    graded: true,
    // The first option is the right one; the order is shuffled per question below.
    choices: options.map((t, i) => ({ id: id * 10 + i, position: i, text: t, is_correct: i === 0 })),
  };
}

function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A small seeded generator, so a demo run can be repeated exactly. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoQuestions(rng: () => number): Question[] {
  return [
    q(1, 'Which tool finds similar sequences in a database?', ['BLAST', 'Photoshop', 'Excel', 'GPS']),
    q(2, 'What does AlphaFold predict?', [
      'Protein structure', 'The weather', 'Stock prices', 'Football scores',
    ]),
    q(3, 'How many letters are there in the DNA alphabet?', ['4', '2', '20', '64']),
    q(4, 'Which amino acid is known as a helix breaker?', ['Proline', 'Alanine', 'Leucine', 'Glutamate']),
  ].map((question) => {
    const choices = shuffled(question.choices, rng).map((c, i) => ({ ...c, position: i }));
    return { ...question, choices };
  });
}

/** One bot's answer to a question: which choice, and after how many ms. */
export interface BotAnswer {
  nickname: string;
  choiceId: number;
  afterMs: number;
}

export function botAnswers(question: Question, limitMs: number, rng: () => number): BotAnswer[] {
  const right = question.choices.find((c) => c.is_correct)!;
  const wrong = question.choices.filter((c) => !c.is_correct);
  return BOTS.map((bot) => {
    const correct = rng() < bot.skill;
    const choice = correct ? right : wrong[Math.floor(rng() * wrong.length)];
    // Somewhere around their pace, never in the first second or the last tenth.
    const share = Math.min(0.9, Math.max(0.08, bot.pace + (rng() - 0.5) * 0.35));
    return { nickname: bot.nickname, choiceId: choice.id, afterMs: Math.round(share * limitMs) };
  });
}

/** The server's scoring: 1000 for an instant right answer, 500 at the buzzer, 0 if wrong. */
export function points(correct: boolean, afterMs: number, limitMs: number): number {
  if (!correct) return 0;
  const fraction = Math.min(1, Math.max(0, afterMs / limitMs));
  return Math.round(DEMO_MAX_POINTS - (DEMO_MAX_POINTS - DEMO_MIN_POINTS) * fraction);
}

/** One question's outcome per nickname; absent means no answer. */
export type RoundOutcome = Record<string, { choiceId: number; points: number; correct: boolean }>;

/**
 * The leaderboard after `rounds`, in the server's shape: ties share a rank and
 * are listed alphabetically, and each entry knows where it stood before the
 * last round and what that round earned it.
 */
export function buildBoard(nicknames: string[], rounds: RoundOutcome[], questions: number): Leaderboard {
  const total = (upTo: number, nick: string) =>
    rounds.slice(0, upTo).reduce((sum, r) => sum + (r[nick]?.points ?? 0), 0);
  const ranks = (scores: Record<string, number>) => {
    const order = [...nicknames].sort(
      (a, b) => scores[b] - scores[a] || a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    const out: Record<string, number> = {};
    order.forEach((n, i) => {
      out[n] = i > 0 && scores[order[i - 1]] === scores[n] ? out[order[i - 1]] : i + 1;
    });
    return out;
  };
  const now = Object.fromEntries(nicknames.map((n) => [n, total(rounds.length, n)]));
  const before = Object.fromEntries(nicknames.map((n) => [n, total(rounds.length - 1, n)]));
  const nowRank = ranks(now);
  const beforeRank = ranks(before);
  const last = rounds[rounds.length - 1] ?? {};
  const entries: LeaderboardEntry[] = nicknames.map((n, i) => ({
    participant_id: i + 1,
    nickname: n,
    score: now[n],
    gained: last[n]?.points ?? 0,
    rank: nowRank[n],
    previous_rank: rounds.length > 1 ? beforeRank[n] : null,
    last_correct: last[n] ? last[n].correct : null,
  }));
  entries.sort((a, b) => a.rank - b.rank || a.nickname.toLowerCase().localeCompare(b.nickname.toLowerCase()));
  return { players: entries.length, rounds_played: rounds.length, questions, last_question_id: null, entries };
}
