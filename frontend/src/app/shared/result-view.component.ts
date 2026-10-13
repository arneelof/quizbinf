import { Component, EventEmitter, Input, Output, signal } from '@angular/core';

import { Question, RoundResult, kindOf, numberAnswer, scaleRange } from '../models';

interface Bin {
  label: string;
  lo: number;
  hi: number;
  pre: number;
  post: number;
}

/**
 * One question's result, for every kind that is not drawn as choice bars:
 * scale, number, word, text, point and rank. Single- and several-choice
 * questions keep the bar chart their views already draw, with its ticks.
 *
 * Used by both the projected Report view and the student's phone. `pre` and
 * `post` are the two rounds; pass only what may be shown (the callers know
 * the mode and which rounds are halted). Everything here is aggregated or
 * anonymous, as the server sends it; nothing names a student.
 *
 * `teacher` adds the controls that only the projecting teacher has: hiding a
 * text answer from the projected cards (and from the students' phones).
 */
@Component({
  selector: 'app-result-view',
  standalone: true,
  template: `
    @switch (kind()) {
      @case ('scale') {
        <div class="hist">
          @for (v of scaleValues(); track v) {
            <div class="row">
              <span class="label">
                <b>{{ v }}</b>
                @if (v === scaleValues()[0] && question.settings?.min_label) {
                  <span class="end">{{ question.settings?.min_label }}</span>
                }
                @if (v === scaleValues()[scaleValues().length - 1] && question.settings?.max_label) {
                  <span class="end">{{ question.settings?.max_label }}</span>
                }
              </span>
              <span class="bars">
                @if (pre) {
                  <span class="line"><span class="bar pre" [style.width.%]="share(pre, v)"></span>
                    <span class="n">{{ pre.counts?.[v] || 0 }}</span></span>
                }
                @if (post) {
                  <span class="line"><span class="bar post" [style.width.%]="share(post, v)"></span>
                    <span class="n">{{ post.counts?.[v] || 0 }}</span></span>
                }
              </span>
            </div>
          }
        </div>
        <p class="stats">
          @if (pre && pre.mean !== null && pre.mean !== undefined) { {{ once ? 'Mean' : 'Mean before' }} {{ fmt(pre.mean) }} }
          @if (post && post.mean !== null && post.mean !== undefined) { &nbsp; Mean after {{ fmt(post.mean) }} }
        </p>
      }

      @case ('number') {
        @if (bins().length) {
          <div class="histo" role="img" [attr.aria-label]="'Histogram of ' + total() + ' answers'">
            @for (b of bins(); track b.label) {
              <div class="col" [class.target]="revealCorrect && inTarget(b)">
                <div class="stack">
                  @if (pre) {
                    <span class="vbar pre" [style.height.%]="vshare(b.pre)" [title]="b.pre + ''">
                      @if (b.pre) { <i>{{ b.pre }}</i> }
                    </span>
                  }
                  @if (post) {
                    <span class="vbar post" [style.height.%]="vshare(b.post)" [title]="b.post + ''">
                      @if (b.post) { <i>{{ b.post }}</i> }
                    </span>
                  }
                </div>
                <span class="tick">{{ b.label }}</span>
              </div>
            }
          </div>
          <p class="stats">
            @if (pre && pre.median !== null && pre.median !== undefined) { {{ once ? 'Median' : 'Median before' }} {{ fmt(pre.median) }} {{ unit() }}. }
            @if (post && post.median !== null && post.median !== undefined) { Median after {{ fmt(post.median) }} {{ unit() }}. }
            @if (revealCorrect && answerText()) { <b class="answer">Answer: {{ answerText() }}</b> }
          </p>
        } @else {
          <p class="none">No answers.</p>
        }
      }

      @case ('word') {
        @for (r of rounds(); track r.label) {
          @if (rounds().length > 1) { <p class="sub">{{ r.label }}</p> }
          <div class="cloud">
            @for (w of cloud(r.result); track w.word) {
              <span class="word" [style.font-size.rem]="w.size" [style.color]="w.colour"
                    [title]="w.count + ''">{{ w.word }}</span>
            } @empty {
              <span class="none">No answers.</span>
            }
          </div>
        }
      }

      @case ('text') {
        @for (r of rounds(); track r.label) {
          @if (rounds().length > 1) { <p class="sub">{{ r.label }}</p> }
          <div class="cards">
            @for (t of visibleTexts(r.result); track t.id) {
              <div class="card" [class.hidden-card]="t.hidden">
                <span class="ctext">{{ t.text }}</span>
                @if (teacher) {
                  <button type="button" class="hide" (click)="hide.emit({ id: t.id, hidden: !t.hidden })"
                          [title]="t.hidden ? 'Show it again' : 'Hide from the projector and the phones'">
                    {{ t.hidden ? 'Restore' : '✕' }}
                  </button>
                }
              </div>
            } @empty {
              <span class="none">No answers.</span>
            }
          </div>
          @if (teacher && hiddenCount(r.result)) {
            <button type="button" class="link" (click)="showHidden.set(!showHidden())">
              {{ showHidden() ? 'Leave out' : 'Show' }} {{ hiddenCount(r.result) }} hidden
            </button>
          }
        }
      }

      @case ('point') {
        <div class="figure">
          <img [src]="question.image_url" alt="" />
          @if (pre) {
            @for (p of pre.points ?? []; track $index) {
              <span class="dot pre" [style.left.%]="p[0] * 100" [style.top.%]="p[1] * 100"></span>
            }
          }
          @if (post) {
            @for (p of post.points ?? []; track $index) {
              <span class="dot post" [style.left.%]="p[0] * 100" [style.top.%]="p[1] * 100"></span>
            }
          }
        </div>
      }

      @case ('rank') {
        <div class="hist">
          @for (c of ranked(); track c.id) {
            <div class="row">
              <span class="label">{{ c.text }}</span>
              <span class="bars">
                @if (pre) {
                  <span class="line"><span class="bar pre" [style.width.%]="rankShare(pre, c.id)"></span>
                    <span class="n">{{ meanRank(pre, c.id) }}</span></span>
                }
                @if (post) {
                  <span class="line"><span class="bar post" [style.width.%]="rankShare(post, c.id)"></span>
                    <span class="n">{{ meanRank(post, c.id) }}</span></span>
                }
              </span>
            </div>
          }
        </div>
        <p class="stats">Longer bar: put nearer the top. The number is the average place.</p>
      }
    }

    <p class="legend">
      @if (pre && post) {
        @if (kind() === 'word' || kind() === 'text') {
          {{ pre.total }} answers before, {{ post.total }} after discussion
        } @else {
          <span class="sw pre"></span> before discussion ({{ pre.total }}) &nbsp;
          <span class="sw post"></span> after discussion ({{ post.total }})
        }
      } @else {
        {{ total() }} answer{{ total() === 1 ? '' : 's' }}
      }
    </p>
  `,
  styles: [
    `
      :host { display: block; }
      .row { display: flex; align-items: center; gap: 0.6rem; margin: 0.45rem 0; }
      .label { width: min(12rem, 38%); flex-shrink: 0; overflow-wrap: anywhere; }
      .label .end { display: block; font-size: 0.8rem; color: #666; }
      .bars { flex: 1; display: flex; flex-direction: column; gap: 3px; }
      .line { display: flex; align-items: center; gap: 0.4rem; }
      .bar { height: 1.1rem; display: block; min-width: 2px; border-radius: 2px; }
      .bar.pre, .vbar.pre, .sw.pre, .dot.pre { background: #9bd; }
      .bar.post, .vbar.post, .sw.post, .dot.post { background: #2c7a51; }
      .n { font-size: 0.8rem; color: #555; }
      .stats, .legend { font-size: 0.85rem; color: #555; margin: 0.6rem 0 0; }
      .answer { color: #2c7a51; margin-left: 0.4rem; }
      .sw { display: inline-block; width: 0.8rem; height: 0.8rem; vertical-align: middle; }
      .none { color: #777; font-style: italic; }
      .sub { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: #777;
             margin: 0.8rem 0 0.2rem; }

      .histo { display: flex; align-items: stretch; gap: 4px; height: 13rem; padding-top: 1.2rem; }
      .col { flex: 1; display: flex; flex-direction: column; align-items: stretch; height: 100%;
             min-width: 0; }
      .col.target { background: #eafaf1; }
      .stack { flex: 1; display: flex; align-items: flex-end; gap: 2px; border-bottom: 1px solid #bbb; }
      .vbar { flex: 1; position: relative; border-radius: 2px 2px 0 0; }
      .vbar i { position: absolute; top: -1.1rem; left: 0; right: 0; text-align: center;
                font-style: normal; font-size: 0.75rem; color: #555; }
      .tick { font-size: 0.72rem; color: #555; text-align: center; margin-top: 0.2rem; height: 1rem;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .cloud { display: flex; flex-wrap: wrap; justify-content: center; align-items: center;
               gap: 0.2rem 0.9rem; padding: 0.8rem; line-height: 1.15; }
      .word { font-weight: 700; }

      .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
               gap: 0.6rem; margin-top: 0.4rem; }
      .card { position: relative; background: #fffbe6; border: 1px solid #eadf9f; border-radius: 6px;
              padding: 0.6rem 1.8rem 0.6rem 0.7rem; font-size: 1.05rem; white-space: pre-wrap;
              overflow-wrap: anywhere; }
      .card.hidden-card { opacity: 0.45; background: #eee; border-color: #ccc; }
      .hide { position: absolute; top: 0.2rem; right: 0.2rem; border: none; background: none;
              cursor: pointer; color: #999; font-size: 0.85rem; }
      .hide:hover { color: #c0392b; }
      .link { border: none; background: none; color: #2e86ab; cursor: pointer; padding: 0;
              margin-top: 0.4rem; font-size: 0.85rem; }

      .figure { position: relative; display: inline-block; max-width: 100%; }
      .figure img { display: block; max-width: 100%; height: auto; border-radius: 6px; }
      .dot { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
             opacity: 0.75; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
             pointer-events: none; }
      /* Stronger than the bars' first-round blue: a dot is small and must read
         from the back of the room. */
      .dot.pre { background: #2f6db5; }
    `,
  ],
})
export class ResultViewComponent {
  @Input({ required: true }) question!: Question;
  @Input() pre: RoundResult | null = null;
  @Input() post: RoundResult | null = null;
  /** Asked once: one round, labelled plainly. */
  @Input() once = false;
  /** Mark the right answer (number questions); only after the last round. */
  @Input() revealCorrect = false;
  /** The projecting teacher's controls: hide text answers. */
  @Input() teacher = false;
  @Output() hide = new EventEmitter<{ id: number; hidden: boolean }>();

  showHidden = signal(false);

  kind() {
    return kindOf(this.question);
  }

  total(): number {
    return (this.post ?? this.pre)?.total ?? 0;
  }

  fmt(x: number): string {
    return Number.isInteger(x) ? `${x}` : x.toFixed(Math.abs(x) < 10 ? 2 : 1);
  }

  /** The rounds to draw separately (words, text), latest last. */
  rounds(): { label: string; result: RoundResult }[] {
    const out: { label: string; result: RoundResult }[] = [];
    if (this.pre) out.push({ label: 'Before discussion', result: this.pre });
    if (this.post) out.push({ label: 'After discussion', result: this.post });
    return out;
  }

  // --- scale ---

  scaleValues(): number[] {
    const [lo, hi] = scaleRange(this.question);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }

  share(r: RoundResult, key: number): number {
    return r.total ? (100 * (r.counts?.[key] || 0)) / r.total : 0;
  }

  // --- number ---

  unit(): string {
    return this.question.settings?.unit ?? '';
  }

  answerText(): string {
    return numberAnswer(this.question);
  }

  /**
   * Bins over both rounds together, so the two are drawn on one axis. Whole
   * numbers over a short range get a bin each; otherwise about eight bins of
   * a round width (1, 2 or 5 times a power of ten).
   */
  bins(): Bin[] {
    const pre = this.pre?.values ?? [];
    const post = this.post?.values ?? [];
    const all = [...pre, ...post];
    if (!all.length) return [];
    const min = Math.min(...all);
    const max = Math.max(...all);
    let step: number;
    let start: number;
    if (all.every(Number.isInteger) && max - min <= 20) {
      step = 1;
      start = min;
    } else {
      const raw = (max - min || Math.abs(max) || 1) / 8;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
      start = Math.floor(min / step) * step;
    }
    const n = Math.max(1, Math.floor((max - start) / step) + 1);
    const bins: Bin[] = Array.from({ length: n }, (_, i) => {
      const lo = start + i * step;
      return {
        lo,
        hi: lo + step,
        label: step === 1 && Number.isInteger(lo) ? `${lo}` : `${this.fmt(+lo.toPrecision(6))}–`,
        pre: 0,
        post: 0,
      };
    });
    const place = (x: number) => Math.min(n - 1, Math.max(0, Math.floor((x - start) / step)));
    pre.forEach((x) => bins[place(x)].pre++);
    post.forEach((x) => bins[place(x)].post++);
    return bins;
  }

  vshare(n: number): number {
    const peak = Math.max(1, ...this.bins().map((b) => Math.max(b.pre, b.post)));
    return (100 * n) / peak;
  }

  inTarget(b: Bin): boolean {
    const s = this.question.settings ?? {};
    if (s.answer === undefined || s.answer === null) return false;
    const t = s.tolerance ?? 0;
    return b.lo <= s.answer + t && b.hi > s.answer - t;
  }

  // --- words ---

  /**
   * The words sized by count, biggest in the middle: they are placed
   * alternately before and after the ones already there.
   */
  cloud(r: RoundResult): { word: string; count: number; size: number; colour: string }[] {
    const words = (r.words ?? []).slice(0, 60);
    const peak = Math.max(1, ...words.map((w) => w.count));
    const colours = ['#1f6f8b', '#2c7a51', '#b5651d', '#7b3f8c', '#a23b3b', '#3d5a80'];
    const sized = words.map((w, i) => ({
      ...w,
      size: 0.95 + 2.6 * Math.pow(w.count / peak, 0.7),
      colour: colours[i % colours.length],
    }));
    const out: typeof sized = [];
    sized.forEach((w, i) => (i % 2 ? out.unshift(w) : out.push(w)));
    return out;
  }

  // --- text ---

  visibleTexts(r: RoundResult) {
    return (r.texts ?? []).filter((t) => !t.hidden || this.showHidden());
  }

  hiddenCount(r: RoundResult): number {
    return (r.texts ?? []).filter((t) => t.hidden).length;
  }

  // --- rank ---

  ranked() {
    const latest = this.post ?? this.pre;
    const mean = (id: number) => latest?.mean_rank?.[id] ?? Infinity;
    return [...this.question.choices].sort((a, b) => mean(a.id) - mean(b.id));
  }

  meanRank(r: RoundResult, id: number): string {
    const m = r.mean_rank?.[id];
    return m === null || m === undefined ? '–' : m.toFixed(1);
  }

  /** Full bar for an average place of 1, none for last place. */
  rankShare(r: RoundResult, id: number): number {
    const n = this.question.choices.length;
    const m = r.mean_rank?.[id];
    if (m === null || m === undefined || n < 2) return 0;
    return Math.max(2, (100 * (n - m)) / (n - 1));
  }
}
