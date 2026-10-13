import { Component, computed, signal } from '@angular/core';

import { AnswerInput, Question, QuestionKind, RoundResult } from '../models';
import { ResultViewComponent } from '../shared/result-view.component';

/** One demo question: what a student sees, and the made-up answers of the rest of the class. */
interface DemoQuestion {
  question: Question;
  about: string;
  /** Answers of the made-up classmates, in the shape the server takes. */
  class: AnswerInput[];
  /** For a question asked twice: the class's answers after discussing. */
  classAfter?: AnswerInput[];
}

const N = 23; // made-up classmates

function q(id: number, kind: QuestionKind, text: string, extra: Partial<Question> = {}): Question {
  return { id, position: id, text, text_html: `<p>${text}</p>`, image_url: null, choices: [], kind,
           mode: 'once', ...extra };
}

function choices(texts: string[], correct: number[] = []) {
  return texts.map((text, i) => ({ id: i + 1, position: i, text, is_correct: correct.includes(i) }));
}

/** `counts[i]` classmates pick choice i + 1. */
function picks(counts: number[]): AnswerInput[] {
  return counts.flatMap((n, i) => Array.from({ length: n }, () => ({ choice_id: i + 1 })));
}

const QUESTIONS: DemoQuestion[] = [
  {
    question: q(1, 'choice',
      'A BLAST hit has E-value 0.01 against a database of one million sequences. What is the same hit\'s ' +
      'E-value against a database ten times larger?',
      { mode: 'twice', choices: choices(['0.001', '0.01', '0.1', '1'], [2]) }),
    about: 'Choose one, asked twice: first on your own, then again after discussing with your neighbour. ' +
      'Your answer joins the first round; the second shows how the class answered after the discussion.',
    class: picks([9, 6, 6, 2]),
    classAfter: picks([3, 2, 17, 1]),
  },
  {
    question: q(2, 'multi', 'Which of these amino acids are hydrophobic? Tick all that apply.',
      { choices: choices(['Leucine', 'Lysine', 'Valine', 'Aspartate', 'Phenylalanine'], [0, 2, 4]) }),
    about: 'Choose all that apply. Each bar is the share of the class who ticked that one.',
    class: [...Array(N)].map((_, i) => ({
      choice_ids: [1, 3, 5, 2].filter((c, k) => (i * 7 + k * 5) % 11 < [9, 8, 6, 2][k]),
    })),
  },
  {
    question: q(3, 'rank', 'Put the genomes in order of size, largest first.',
      { choices: choices(['Human', 'Escherichia coli', 'SARS-CoV-2', 'Baker\'s yeast']) }),
    about: 'Put in order. The bars show the average place each one was given.',
    class: [...Array(N)].map((_, i) => ({ choice_ids: i % 4 === 0 ? [1, 2, 4, 3] : i % 7 === 1 ? [4, 1, 2, 3] : [1, 4, 2, 3] })),
  },
  {
    question: q(4, 'number', 'About how many protein-coding genes does the human genome have, in thousands?',
      { settings: { unit: 'thousand', answer: 20, tolerance: 2 } }),
    about: 'A number, drawn as a histogram with the mean and median. The right range is shaded once the ' +
      'teacher shows the answer.',
    class: [5, 12, 15, 18, 19, 20, 20, 20, 21, 22, 23, 25, 25, 25, 30, 30, 30, 35, 40, 45, 50, 60, 19]
      .map((number) => ({ number })),
  },
  {
    question: q(5, 'scale', 'How confident are you in writing Python?',
      { settings: { min: 1, max: 5, min_label: 'not at all', max_label: 'very' } }),
    about: 'A scale. Good for a quick reading of the room at the start of a lecture.',
    class: [1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 2, 3, 4, 1, 3, 4, 5, 3, 2].map((number) => ({ number })),
  },
  {
    question: q(6, 'word', 'In up to three words: what was the hardest part of today?',
      { settings: { max_words: 3 } }),
    about: 'A few words, drawn as a word cloud: the more students wrote a word, the bigger it is.',
    class: [['backpropagation'], ['gradients', 'chain rule'], ['backpropagation'], ['learning rate'],
      ['chain rule'], ['overfitting'], ['backpropagation', 'notation'], ['PyTorch'], ['gradients'],
      ['chain rule', 'matrices'], ['loss'], ['learning rate'], ['backpropagation'], ['notation'], ['XOR'],
      ['gradients'], ['matrices'], ['backpropagation'], ['hidden layer'], ['loss', 'gradients'], ['PyTorch'],
      ['chain rule'], ['overfitting']].map((words) => ({ words })),
  },
  {
    question: q(7, 'text', 'What would you like explained again next time?', { settings: { max_length: 280 } }),
    about: 'Free text, shown as cards without names. The teacher can hide a card from the projector.',
    class: ['Why the gradient points uphill and we step the other way.',
      'How the chain rule turns into backpropagation, step by step.',
      'What a hidden layer actually learns.', 'When to stop training: the validation curve.',
      'The difference between an epoch and a batch.']
      .map((text) => ({ text })),
  },
  {
    question: q(8, 'point', 'Tap on the mitochondrion.', { image_url: 'demo/cell.svg' }),
    about: 'Tap on a figure. Every tap becomes a dot, so you see where the class looked.',
    class: [[0.72, 0.33], [0.7, 0.3], [0.74, 0.36], [0.69, 0.34], [0.73, 0.31], [0.38, 0.45], [0.76, 0.33],
      [0.71, 0.29], [0.68, 0.7], [0.72, 0.35], [0.4, 0.43], [0.75, 0.3], [0.7, 0.32], [0.73, 0.34],
      [0.71, 0.37], [0.66, 0.3], [0.72, 0.28], [0.78, 0.35], [0.7, 0.69], [0.74, 0.32], [0.37, 0.47],
      [0.73, 0.33], [0.71, 0.31]].map((p) => ({ point: p as [number, number] })),
  },
];

/**
 * A public demo of the question kinds, at /demo. It runs entirely in the browser: nothing is sent to
 * the server and nothing is stored, so it needs no login. The results combine the visitor's answer with
 * made-up answers from a class of 23.
 */
@Component({
  selector: 'app-demo',
  standalone: true,
  imports: [ResultViewComponent],
  template: `
    <div class="wrap">
      <h1>Try the lecture quiz</h1>
      <p class="lede">
        This is how students answer during a lecture (left), and what the projector shows when the
        teacher halts the question (right). Answer as a student: the results combine your answer with
        made-up answers from 23 classmates. Nothing is sent or stored.
      </p>
      <nav class="steps">
        @for (d of questions; track d.question.id; let i = $index) {
          <button [class.on]="i === current()" (click)="go(i)">{{ i + 1 }}. {{ kindName(d) }}</button>
        }
      </nav>

      @let d = demo();
      @let qn = d.question;
      <p class="about">{{ d.about }}</p>
      <div class="panes">
        <section class="phone">
          <p class="label">Student's phone</p>
          <div class="screen">
            <p class="phase">{{ qn.mode === 'twice' ? 'First answer' : 'Answer' }}</p>
            <div class="qtext" [innerHTML]="qn.text_html"></div>
            @switch (qn.kind) {
              @case ('choice') {
                @for (c of qn.choices; track c.id) {
                  <button class="choice" [class.selected]="mine()?.choice_id === c.id"
                          (click)="answer({ choice_id: c.id })">{{ c.text }}</button>
                }
              }
              @case ('multi') {
                @for (c of qn.choices; track c.id) {
                  <button class="choice" [class.selected]="ticks().includes(c.id)" (click)="tick(c.id)">
                    {{ ticks().includes(c.id) ? '☑' : '☐' }} {{ c.text }}
                  </button>
                }
                <button class="send" [disabled]="!ticks().length" (click)="answer({ choice_ids: ticks() })">Send</button>
              }
              @case ('rank') {
                <ol class="ranking">
                  @for (id of order(); track id; let i = $index) {
                    <li>
                      <span>{{ choiceText(id) }}</span>
                      <button [disabled]="i === 0" (click)="move(i, -1)" aria-label="Move up">↑</button>
                      <button [disabled]="i === order().length - 1" (click)="move(i, 1)" aria-label="Move down">↓</button>
                    </li>
                  }
                </ol>
                <button class="send" (click)="answer({ choice_ids: order() })">Send</button>
              }
              @case ('number') {
                <div class="numrow">
                  <input type="number" step="any" [value]="draft()" (input)="draft.set($any($event.target).value)"
                         aria-label="Your answer" />
                  <span>{{ qn.settings?.unit }}</span>
                </div>
                <button class="send" [disabled]="draft().trim() === ''" (click)="answer({ number: +draft() })">Send</button>
              }
              @case ('scale') {
                <div class="scale">
                  @for (v of [1, 2, 3, 4, 5]; track v) {
                    <button [class.selected]="mine()?.number === v" (click)="answer({ number: v })">{{ v }}</button>
                  }
                </div>
                <div class="ends"><span>{{ qn.settings?.min_label }}</span><span>{{ qn.settings?.max_label }}</span></div>
              }
              @case ('word') {
                @for (w of [0, 1, 2]; track w) {
                  <input class="word" maxlength="40" [value]="words()[w]" (input)="setWord(w, $any($event.target).value)"
                         [attr.aria-label]="'Word ' + (w + 1)" />
                }
                <button class="send" [disabled]="!hasWords()" (click)="answer({ words: cleanWords() })">Send</button>
              }
              @case ('text') {
                <textarea rows="4" maxlength="280" [value]="draft()" (input)="draft.set($any($event.target).value)"
                          aria-label="Your answer"></textarea>
                <button class="send" [disabled]="!draft().trim()" (click)="answer({ text: draft().trim() })">Send</button>
              }
              @case ('point') {
                <div class="tap" (click)="tap($event)">
                  <img [src]="qn.image_url" alt="A cell with a nucleus, a mitochondrion and other organelles" draggable="false" />
                  @if (mine()?.point; as p) {
                    <span class="marker" [style.left.%]="p[0] * 100" [style.top.%]="p[1] * 100"></span>
                  }
                </div>
              }
            }
            @if (mine()) { <p class="saved">Answer saved. You can change it.</p> }
          </div>
        </section>

        <section class="projector">
          <p class="label">Projector, after the teacher halts the question</p>
          @if (!mine()) {
            <p class="wait">Answer on the phone to see the results.</p>
          } @else {
            <div class="qtext" [innerHTML]="qn.text_html"></div>
            @if (qn.kind === 'choice' || qn.kind === 'multi') {
              <div class="bars">
                @for (c of qn.choices; track c.id) {
                  <div class="row">
                    <span class="ctext">{{ c.text }} @if (c.is_correct) { <b class="ok">✓</b> }</span>
                    <span class="lines">
                      <span class="line"><span class="bar pre" [style.width.%]="share(pre(), c.id)"></span>
                        <span class="n">{{ count(pre(), c.id) }}</span></span>
                      @if (post()) {
                        <span class="line"><span class="bar post" [style.width.%]="share(post(), c.id)"></span>
                          <span class="n">{{ count(post(), c.id) }}</span></span>
                      }
                    </span>
                  </div>
                }
              </div>
              <p class="legend">
                @if (post()) {
                  <span class="key pre"></span> first answers &nbsp; <span class="key post"></span> after discussion
                } @else { {{ pre().total }} answers }
              </p>
            } @else {
              <app-result-view [question]="qn" [pre]="pre()" [once]="true" [revealCorrect]="true" />
            }
          }
        </section>
      </div>
      <p class="foot">
        In a lecture, students log in with their university account, so that answering counts as attendance;
        right or wrong is never graded. Teachers write the questions in Markdown, one file per lecture.
      </p>
    </div>
  `,
  styles: [
    `
      .wrap { max-width: 68rem; margin: 0 auto; padding: 1.2rem 16px 3rem; }
      h1 { margin: 0.2rem 0 0.4rem; color: #045c64; }
      .lede { max-width: 48rem; color: #444; }
      .steps { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 1rem 0 0.4rem; }
      .steps button { border: 1px solid #c9d6d7; background: #fff; border-radius: 999px; padding: 0.3rem 0.8rem;
                      cursor: pointer; font-size: 0.9rem; }
      .steps button.on { background: #045c64; border-color: #045c64; color: #fff; }
      .about { color: #555; max-width: 48rem; min-height: 2.6rem; }
      .panes { display: grid; grid-template-columns: minmax(0, 22rem) minmax(0, 1fr); gap: 1.5rem; align-items: start; }
      @media (max-width: 760px) { .panes { grid-template-columns: minmax(0, 1fr); } }
      .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.07em; color: #777; margin: 0 0 0.4rem; }
      .screen { border: 10px solid #222; border-radius: 26px; padding: 1rem; min-height: 26rem; background: #fff; }
      .phase { color: #2c7a51; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
      .choice { display: block; width: 100%; text-align: left; margin: 0.35rem 0; padding: 0.7rem; font-size: 1rem;
                border: 2px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer; }
      .choice.selected { border-color: #2c7a51; background: #eafaf1; }
      .send { margin-top: 0.6rem; padding: 0.55rem 1.2rem; font-size: 1rem; border-radius: 8px; border: none;
              background: #045c64; color: #fff; cursor: pointer; }
      .send:disabled { background: #aab; cursor: default; }
      .ranking { padding-left: 1.4rem; } .ranking li { margin: 0.3rem 0; display: flex; gap: 0.3rem; align-items: center; }
      .ranking li span { flex: 1; }
      .numrow { display: flex; gap: 0.5rem; align-items: center; }
      input, textarea { font: inherit; font-size: 1.1rem; padding: 0.5rem; border: 2px solid #ccc; border-radius: 8px;
                        width: 100%; box-sizing: border-box; }
      .numrow input { width: 8rem; }
      .word { display: block; margin: 0.35rem 0; }
      .scale { display: flex; gap: 0.4rem; } .scale button { flex: 1; padding: 0.8rem 0; font-size: 1.1rem;
               border: 2px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer; }
      .scale button.selected { border-color: #2c7a51; background: #eafaf1; }
      .ends { display: flex; justify-content: space-between; color: #777; font-size: 0.85rem; }
      .tap { position: relative; cursor: crosshair; } .tap img { width: 100%; display: block; border-radius: 6px; }
      .marker { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
                background: #c0392b; border: 2px solid #fff; box-shadow: 0 0 0 1px #0006; }
      .saved { color: #2c7a51; font-size: 0.9rem; }
      .projector { border: 1px solid #d5ddda; border-radius: 8px; padding: 1rem 1.2rem; background: #fafcfb; min-height: 26rem; }
      .wait { color: #888; font-style: italic; }
      .bars .row { display: grid; grid-template-columns: minmax(0, 13rem) minmax(0, 1fr); gap: 0.6rem; margin: 0.5rem 0;
                   align-items: center; }
      .lines { display: flex; flex-direction: column; gap: 2px; }
      .line { display: flex; align-items: center; gap: 0.4rem; }
      .bar { height: 1.1rem; border-radius: 2px; min-width: 2px; }
      .bar.pre, .key.pre { background: #8fb3de; } .bar.post, .key.post { background: #2c7a51; }
      .key { display: inline-block; width: 0.9rem; height: 0.9rem; vertical-align: middle; border-radius: 2px; }
      .n { font-size: 0.8rem; color: #555; }
      .ok { color: #2c7a51; }
      .legend { color: #666; font-size: 0.85rem; }
      .foot { color: #777; font-size: 0.85rem; margin-top: 2rem; max-width: 48rem; }
    `,
  ],
})
export class DemoComponent {
  readonly questions = QUESTIONS;
  current = signal(0);
  demo = computed(() => QUESTIONS[this.current()]);
  /** The visitor's answer to each question, by question id. */
  answers = signal<Record<number, AnswerInput>>({});
  mine = computed<AnswerInput | null>(() => this.answers()[this.demo().question.id] ?? null);

  ticks = signal<number[]>([]);
  order = signal<number[]>([]);
  draft = signal('');
  words = signal(['', '', '']);

  constructor() {
    this.go(0);
  }

  go(i: number): void {
    this.current.set(i);
    const q = QUESTIONS[i].question;
    const mine = this.answers()[q.id];
    this.ticks.set(mine?.choice_ids ?? []);
    this.order.set(mine?.choice_ids ?? q.choices.map((c) => c.id));
    this.draft.set(mine?.number !== undefined ? String(mine.number) : (mine?.text ?? ''));
    this.words.set([0, 1, 2].map((k) => mine?.words?.[k] ?? ''));
  }

  kindName(d: DemoQuestion): string {
    return { choice: 'Choose one', multi: 'Tick all', rank: 'Ranking', number: 'Number', scale: 'Scale',
             word: 'Word cloud', text: 'Free text', point: 'Tap a figure' }[d.question.kind ?? 'choice'];
  }

  answer(a: AnswerInput): void {
    this.answers.update((all) => ({ ...all, [this.demo().question.id]: a }));
  }

  tick(id: number): void {
    this.ticks.update((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  move(i: number, step: number): void {
    this.order.update((o) => {
      const next = [...o];
      [next[i], next[i + step]] = [next[i + step], next[i]];
      return next;
    });
  }

  choiceText(id: number): string {
    return this.demo().question.choices.find((c) => c.id === id)?.text ?? '';
  }

  setWord(k: number, value: string): void {
    this.words.update((w) => w.map((x, i) => (i === k ? value : x)));
  }

  cleanWords(): string[] {
    return this.words().map((w) => w.trim()).filter(Boolean);
  }

  hasWords(): boolean {
    return this.cleanWords().length > 0;
  }

  tap(event: MouseEvent): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    this.answer({ point: [x, y] });
  }

  /** The first (or only) round: the class plus the visitor. */
  pre = computed(() => result(this.demo().question, [...this.demo().class, ...(this.mine() ? [this.mine()!] : [])]));

  /** A question asked twice: the class after discussing (the visitor answered the first round). */
  post = computed(() => (this.demo().classAfter ? result(this.demo().question, this.demo().classAfter!) : null));

  count(r: RoundResult | null, id: number): number {
    return r?.counts?.[id] ?? 0;
  }

  share(r: RoundResult | null, id: number): number {
    return r && r.total ? (100 * this.count(r, id)) / r.total : 0;
  }
}

/** The same aggregate the server's `round_result` gives, computed here from the demo answers. */
function result(q: Question, answers: AnswerInput[]): RoundResult {
  const r: RoundResult = { kind: q.kind ?? 'choice', total: answers.length };
  const tally = (keys: number[]) => {
    const counts: Record<number, number> = {};
    for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
    return counts;
  };
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  switch (r.kind) {
    case 'choice':
      r.counts = tally(answers.map((a) => a.choice_id!));
      break;
    case 'multi':
      r.counts = tally(answers.flatMap((a) => a.choice_ids ?? []));
      break;
    case 'rank': {
      r.mean_rank = {};
      for (const c of q.choices) {
        r.mean_rank[c.id] = mean(answers.map((a) => (a.choice_ids ?? []).indexOf(c.id) + 1).filter((p) => p > 0));
      }
      break;
    }
    case 'scale':
    case 'number': {
      const values = answers.map((a) => a.number!).filter((v) => v !== undefined && !Number.isNaN(v));
      r.values = values;
      r.counts = tally(values);
      r.mean = mean(values);
      const s = [...values].sort((a, b) => a - b);
      r.median = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
      break;
    }
    case 'word': {
      const counts = new Map<string, number>();
      for (const w of answers.flatMap((a) => a.words ?? [])) {
        const key = w.trim().toLowerCase();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      r.words = [...counts].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count);
      break;
    }
    case 'text':
      r.texts = answers.map((a, i) => ({ id: i + 1, text: a.text ?? '' })).reverse();
      break;
    case 'point':
      r.points = answers.map((a) => a.point!).filter(Boolean);
      break;
  }
  return r;
}
