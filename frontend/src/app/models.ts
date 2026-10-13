export type Role = 'teacher' | 'student';
export type Phase = 'pre' | 'post';

export interface User {
  username: string;
  display_name: string;
  role: Role;
}

export interface Choice {
  id: number;
  position: number;
  text: string;
  is_correct?: boolean; // present only in teacher views
}

/**
 * How a question is run. `once`: one round, result shown when halted.
 * `twice`: pre and post, each result shown as it is halted. `twice_end`: pre
 * and post, nothing shown until post is halted, then both.
 */
export type QuestionMode = 'once' | 'twice' | 'twice_end';

export const QUESTION_MODES: { value: QuestionMode; label: string }[] = [
  { value: 'twice', label: 'Ask twice, show results after each round' },
  { value: 'twice_end', label: 'Ask twice, show results only after the second (both rounds)' },
  { value: 'once', label: 'Ask once, show results after it' },
];

/** What a student gives as an answer; see the backend's `QuestionKind`. */
export type QuestionKind =
  | 'choice'
  | 'multi'
  | 'rank'
  | 'number'
  | 'scale'
  | 'word'
  | 'text'
  | 'point';

export const QUESTION_KINDS: { value: QuestionKind; label: string }[] = [
  { value: 'choice', label: 'Choose one (a right answer is optional)' },
  { value: 'multi', label: 'Choose all that apply' },
  { value: 'rank', label: 'Put in order (ranking)' },
  { value: 'number', label: 'A number (histogram)' },
  { value: 'scale', label: 'A scale, e.g. 1–5' },
  { value: 'word', label: 'A few words (word cloud)' },
  { value: 'text', label: 'Free text (answer cards)' },
  { value: 'point', label: 'Tap on a figure' },
];

/** Kinds whose answers are one or more of the question's choices. */
export const CHOICE_KINDS: QuestionKind[] = ['choice', 'multi', 'rank'];

/** Per-kind settings. `answer` and `tolerance` reach teachers only. */
export interface QuestionSettings {
  min?: number;
  max?: number;
  unit?: string;
  answer?: number;
  tolerance?: number;
  min_label?: string;
  max_label?: string;
  max_words?: number;
  max_length?: number;
}

export function kindOf(q: { kind?: QuestionKind }): QuestionKind {
  return q.kind ?? 'choice';
}

/** The ends of a scale question, with the defaults the server uses. */
export function scaleRange(q: { settings?: QuestionSettings }): [number, number] {
  return [q.settings?.min ?? 1, q.settings?.max ?? 5];
}

/** One line saying what kind of answer a question asks for, for teacher screens. */
export function describeKind(q: Question): string {
  const s = q.settings ?? {};
  switch (kindOf(q)) {
    case 'multi':
      return 'Choose all that apply';
    case 'rank':
      return 'Put in order';
    case 'number': {
      const range = s.min !== undefined && s.max !== undefined ? `, ${s.min}–${s.max}` : '';
      return `A number${s.unit ? ` (${s.unit})` : ''}${range}`;
    }
    case 'scale': {
      const [lo, hi] = scaleRange(q);
      const ends = s.min_label || s.max_label ? ` (${s.min_label ?? lo} … ${s.max_label ?? hi})` : '';
      return `Scale ${lo}–${hi}${ends}`;
    }
    case 'word':
      return `Up to ${s.max_words ?? 3} words — word cloud`;
    case 'text':
      return 'Free text — answer cards';
    case 'point':
      return 'Tap on the figure';
    default:
      return '';
  }
}

/** The right answer of a number question, as text, or '' when there is none. */
export function numberAnswer(q: Question): string {
  const s = q.settings ?? {};
  if (s.answer === undefined || s.answer === null) return '';
  return `${s.answer}${s.tolerance ? ` ± ${s.tolerance}` : ''}${s.unit ? ` ${s.unit}` : ''}`;
}

/** An answer, in the shape the server takes; which field depends on the kind. */
export interface AnswerInput {
  choice_id?: number;
  choice_ids?: number[];
  number?: number;
  words?: string[];
  text?: string;
  point?: [number, number];
}

/**
 * Everything needed to draw one round's result (the backend's `round_result`).
 * Aggregated or anonymous only.
 */
export interface RoundResult {
  kind: QuestionKind;
  total: number;
  /** Per choice id (choice, multi; rank: put first) or per value (scale). */
  counts?: Record<number, number>;
  values?: number[];
  mean?: number | null;
  median?: number | null;
  words?: { word: string; count: number }[];
  /** `hidden` is present only in the teacher's view. */
  texts?: { id: number; text: string; hidden?: boolean }[];
  points?: [number, number][];
  rank_counts?: Record<number, number[]>;
  mean_rank?: Record<number, number | null>;
}

export interface Question {
  id: number;
  position: number;
  /** Markdown source, as authored. */
  text: string;
  /** `text` rendered and sanitised server-side; bind this for display. */
  text_html: string;
  image_url: string | null;
  choices: Choice[];
  /** Optional so mocks that predate modes keep compiling; absent means `twice`. */
  mode?: QuestionMode;
  /** Absent means `choice`. */
  kind?: QuestionKind;
  settings?: QuestionSettings;
  /** Teacher views only: whether answers can be right or wrong. */
  graded?: boolean;
}

export interface Quiz {
  id: number;
  title: string;
  questions: Question[];
}

export interface Round {
  id: number;
  question_id: number;
  phase: Phase;
  opened_at: string;
  closed_at: string | null;
}

export interface SessionState {
  code: string;
  quiz_id: number;
  quiz_title: string;
  open_round: Round | null;
  question: Question | null;
  my_choice_id: number | null;
  /** The student's own answer to the open round, for every kind. */
  my_answer?: AnswerInput | null;
  // Populated only while no round is open, so a student's own device can
  // show the same bar chart the teacher's Report view reveals once
  // submissions are halted. Optional (not just nullable) so existing mocks
  // that predate this field keep compiling.
  closed_round?: Round | null;
  closed_round_question?: Question | null;
  closed_round_histogram?: Record<number, number> | null;
  /** With a closed post round: the same question's pre distribution. */
  closed_round_pre_histogram?: Record<number, number> | null;
  /** Students join without logging in and their answers are not linked to them. */
  anonymous?: boolean;
  /** The same rounds as RoundResult, for every kind; hidden text answers left out. */
  closed_round_result?: RoundResult | null;
  closed_round_pre_result?: RoundResult | null;
}

export interface Histogram {
  round_id: number;
  phase: Phase;
  counts: Record<number, number>;
  total: number;
}

export interface Participants {
  joined: number;
  connected: number;
}

export interface ParticipantAnswer {
  question_id: number;
  pre: boolean | null;
  post: boolean | null;
  /** False: the question has no right answer, and true only means "answered". */
  graded?: boolean;
}

export interface ParticipantRow {
  username: string;
  display_name: string;
  answers: ParticipantAnswer[];
  answered: number;
  pre_correct: number;
  post_correct: number;
}

export interface ParticipationReport {
  questions: Question[];
  rows: ParticipantRow[];
}

export interface LiveCount {
  open_round: Round | null;
  answered: number;
}

/**
 * Two students drawn to say how they reasoned.
 *
 * `names` is the draw. `reel` is only what the projected view spins through
 * before it settles: it comes from everyone who joined the session, never from
 * the subset who answered this question, so a name flashing past discloses
 * nothing about participation.
 */
export interface Draw {
  names: string[];
  reel: string[];
}

export interface Comparison {
  question_id: number;
  pre: Record<number, number> | null;
  post: Record<number, number> | null;
  pre_result?: RoundResult | null;
  post_result?: RoundResult | null;
}

export interface QuizSession {
  id: number;
  code: string;
  quiz_id: number;
  created_at: string;
  is_anonymous?: boolean;
}

// Payload shapes for creating a question (no server-assigned ids yet).
export interface ChoiceInput {
  text: string;
  is_correct: boolean;
}

export interface QuestionInput {
  text: string;
  image_url: string | null;
  choices: ChoiceInput[];
  mode?: QuestionMode;
  kind?: QuestionKind;
  settings?: QuestionSettings | null;
}

/**
 * A choice in an edit. `id` marks one that already exists, so the server can
 * tell a reworded choice from a new one — answers point at choice ids, and a
 * choice students have answered must not be dropped.
 */
export interface ChoiceEditInput extends ChoiceInput {
  id?: number;
}

/** Which login forms a deployment offers. */
export interface LoginMethods {
  mock_login: boolean;
  roster_login: boolean;
  oidc: boolean;
  /** The login button's text, naming the provider. */
  oidc_label?: string;
}

/** A Canvas course the teacher can sync a roster from. */
export interface CanvasCourse {
  id: number;
  name: string;
  code: string | null;
  /** Canvas workflow_state: "unpublished" | "available" | "completed". */
  state: string | null;
}

export interface SyncedCourse {
  course_id: number;
  students: number;
  synced_at: string;
}

export interface RosterStatus {
  canvas_configured: boolean;
  canvas_base_url: string;
  courses: SyncedCourse[];
}

export interface SyncSummary {
  course_id: number;
  total: number;
  added: number;
  updated: number;
  removed: number;
}

export interface QuestionEditInput {
  text: string;
  image_url: string | null;
  choices: ChoiceEditInput[];
  mode?: QuestionMode;
  kind?: QuestionKind;
  settings?: QuestionSettings | null;
}

/** Whether this lecture's Canvas file can be imported — see api.service. */
export interface CanvasReadiness {
  course_id: number;
  students: number;
  matched: number;
  unmatched: string[];
  roster_students: number;
  synced_at: string | null;
}
