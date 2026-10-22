import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';
import {
  AnswerInput,
  Question,
  QuestionKind,
  SessionState,
  Standing,
  kindOf,
  msLeft,
  scaleRange,
} from '../models';
import { ResultViewComponent } from '../shared/result-view.component';
import {
  AnswerTilesComponent,
  CountdownBarComponent,
  GameVerdictComponent,
  NicknameFormComponent,
} from './competition.components';

/** How many times a phone re-sends an answer the server was too busy to take. */
const SEND_RETRIES = 3;
/**
 * A competition's whole class asks for its standing the moment a question
 * closes; each phone waits up to this long first, so they do not all arrive
 * in the same instant.
 */
const STANDING_SPREAD_MS = 1500;
/** How often the phone's countdown redraws. */
const CLOCK_TICK_MS = 250;
/** The first wait, doubled each attempt and jittered — see `answer()`. */
const SEND_BACKOFF_MS = 400;
/**
 * Statuses that mean the answer never reached a server with an opinion on it:
 * 0 is a dropped connection, 503 the app shedding load, and 502 and 504 the
 * proxy in front of the app failing to reach it.
 */
const RETRYABLE_STATUSES = [0, 502, 503, 504];

@Component({
  selector: 'app-student-session',
  standalone: true,
  imports: [
    ResultViewComponent,
    AnswerTilesComponent,
    CountdownBarComponent,
    GameVerdictComponent,
    NicknameFormComponent,
  ],
  template: `
    <div class="wrap">
      @if (state(); as s) {
        <h2>{{ s.quiz_title }}</h2>
        @if (s.anonymous) {
          <p class="anon">Anonymous — your answers are not linked to you.</p>
        }
        @if (s.competition && standing()?.nickname; as nick) {
          <p class="anon">🏆 Playing as <strong>{{ nick }}</strong></p>
        }

        @if (s.competition && standingLoaded() && (!standing()?.nickname || renaming())) {
          <app-nickname-form [current]="standing()?.nickname ?? null" [error]="nicknameError()"
                             [busy]="nicknameBusy()" (chosen)="chooseNickname($event)" />
        } @else if (s.open_round && s.question) {
          <p class="phase">
            {{
              s.competition
                ? 'Question'
                : s.question.mode === 'once'
                ? 'Answer'
                : s.open_round.phase === 'pre'
                  ? 'First answer'
                  : 'Answer again after discussion'
            }}
          </p>
          <div class="qtext" [innerHTML]="s.question.text_html"></div>
          @if (s.question.image_url && kind(s.question) !== 'point') {
            <img [src]="s.question.image_url" alt="" />
          }
          @if (s.competition) {
            <app-countdown-bar [msLeft]="clockLeft()" [limitSeconds]="s.time_limit ?? 20" />
          }
          @if (s.competition && kind(s.question) === 'choice') {
            <app-answer-tiles [choices]="s.question.choices" [picked]="selected()"
                              [locked]="selected() !== null || sending() || clockLeft() === 0"
                              (pick)="answer($event)" />
          } @else {
          @switch (kind(s.question)) {
            @case ('choice') {
              <div class="choices">
                @for (c of s.question.choices; track c.id) {
                  <button
                    class="choice"
                    [class.selected]="selected() === c.id"
                    (click)="answer(c.id)"
                  >
                    {{ c.text }}
                  </button>
                }
              </div>
            }
            @case ('multi') {
              <p class="how">Tick all that apply, then send.</p>
              <div class="choices">
                @for (c of s.question.choices; track c.id) {
                  <button class="choice" [class.selected]="picks().includes(c.id)"
                          (click)="togglePick(c.id)">
                    <span class="box">{{ picks().includes(c.id) ? '☑' : '☐' }}</span> {{ c.text }}
                  </button>
                }
              </div>
              <button class="send" [disabled]="!picks().length" (click)="send({ choice_ids: picks() })">Send</button>
            }
            @case ('rank') {
              <p class="how">Put them in order, top first, with the arrows. Then send.</p>
              <ol class="ranking">
                @for (id of order(); track id; let i = $index) {
                  <li>
                    <span class="rtext">{{ choiceText(s.question, id) }}</span>
                    <button type="button" aria-label="Move up" [disabled]="i === 0" (click)="move(i, -1)">↑</button>
                    <button type="button" aria-label="Move down" [disabled]="i === order().length - 1" (click)="move(i, 1)">↓</button>
                  </li>
                }
              </ol>
              <button class="send" (click)="send({ choice_ids: order() })">Send</button>
            }
            @case ('number') {
              <div class="numrow">
                <input class="num" type="number" inputmode="decimal" step="any"
                       [min]="s.question.settings?.min ?? null" [max]="s.question.settings?.max ?? null"
                       [value]="numberDraft()" (input)="numberDraft.set($any($event.target).value)"
                       (keyup.enter)="sendNumber()" aria-label="Your answer" />
                @if (s.question.settings?.unit) { <span class="unit">{{ s.question.settings?.unit }}</span> }
              </div>
              @if (s.question.settings?.min !== undefined && s.question.settings?.max !== undefined) {
                <p class="how">Between {{ s.question.settings?.min }} and {{ s.question.settings?.max }}.</p>
              }
              <button class="send" [disabled]="numberDraft().trim() === ''" (click)="sendNumber()">Send</button>
            }
            @case ('scale') {
              <div class="scale">
                @for (v of scaleValues(s.question); track v) {
                  <button class="step" [class.selected]="numberSent() === v"
                          (click)="send({ number: v })">{{ v }}</button>
                }
              </div>
              <div class="ends">
                <span>{{ s.question.settings?.min_label }}</span>
                <span>{{ s.question.settings?.max_label }}</span>
              </div>
            }
            @case ('word') {
              <p class="how">Up to {{ maxWords(s.question) }} word{{ maxWords(s.question) === 1 ? '' : 's' }}, one per box.</p>
              @for (w of wordDraft(); track $index) {
                <input class="word" [value]="w" maxlength="40" [attr.aria-label]="'Word ' + ($index + 1)"
                       (input)="setWord($index, $any($event.target).value)" (keyup.enter)="sendWords()" />
              }
              <button class="send" [disabled]="!hasWords()" (click)="sendWords()">Send</button>
            }
            @case ('text') {
              <textarea class="text" rows="5" [attr.maxlength]="maxLength(s.question)"
                        [value]="textDraft()" (input)="textDraft.set($any($event.target).value)"
                        aria-label="Your answer"></textarea>
              <p class="how">{{ textDraft().length }} / {{ maxLength(s.question) }} characters. Shown to the class without your name.</p>
              <button class="send" [disabled]="!textDraft().trim()" (click)="send({ text: textDraft() })">Send</button>
            }
            @case ('point') {
              <p class="how">Tap the place on the figure. Tap again to move it.</p>
              <div class="tap" (click)="tap($event)">
                <img [src]="s.question.image_url" alt="" draggable="false" />
                @if (pointSent(); as p) {
                  <span class="marker" [style.left.%]="p[0] * 100" [style.top.%]="p[1] * 100"></span>
                }
              </div>
            }
          }
          }
          @if (sending()) {
            <p class="sending">Sending…</p>
          } @else if (sendError()) {
            <p class="error">{{ sendError() }}</p>
          } @else if (saved() && s.competition) {
            <p class="saved">Locked in! Watch the big screen. 🤞</p>
          } @else if (saved()) {
            <p class="saved">Answer saved — you can change it while the question is open.</p>
          } @else if (s.competition && clockLeft() === 0) {
            <p class="error">Time's up!</p>
          }
        } @else if (s.competition) {
          @if (s.closed_round) {
            <app-game-verdict [standing]="standingRound() === s.closed_round.id ? standing() : null" />
          } @else {
            <p class="waiting">You're in! Watch the big screen — the game starts soon.</p>
          }
          @if (standing()?.nickname) {
            <p class="rename"><button type="button" (click)="renaming.set(true)">Change nickname</button></p>
          }
        } @else {
          @if (s.closed_round_result && s.closed_round_question && !isBars(s.closed_round_question)) {
            <p class="phase">Results</p>
            <div class="qtext" [innerHTML]="s.closed_round_question.text_html"></div>
            <app-result-view
              [question]="s.closed_round_question"
              [pre]="s.closed_round?.phase === 'post' ? (s.closed_round_pre_result ?? null) : s.closed_round_result"
              [post]="s.closed_round?.phase === 'post' ? s.closed_round_result : null"
              [once]="s.closed_round_question.mode === 'once'"
            />
          } @else if (s.closed_round_histogram && s.closed_round_question) {
            <p class="phase">Results</p>
            <div class="qtext" [innerHTML]="s.closed_round_question!.text_html"></div>
            <div class="hist">
              @for (c of s.closed_round_question!.choices; track c.id) {
                <div class="row" [class.mine]="selected() === c.id || mine().includes(c.id)">
                  <span class="label">{{ c.text }}</span>
                  <!-- After a second round, both are shown: first above, second below. -->
                  @if (s.closed_round_pre_histogram; as pre) {
                    <span class="bar-line">
                      <span class="bar first" [style.width.%]="pct(c.id, pre, s.closed_round_pre_result?.total)"></span>
                      <span class="n">{{ count(c.id, pre) }}</span>
                    </span>
                  }
                  <span class="bar-line">
                    <span class="bar" [style.width.%]="pct(c.id, undefined, s.closed_round_result?.total)"></span>
                    <span class="n">{{ count(c.id) }}</span>
                  </span>
                </div>
              }
            </div>
            @if (s.closed_round_pre_histogram; as pre) {
              <p class="total">
                <span class="sw first"></span> first answers ({{ s.closed_round_pre_result?.total ?? histTotal(pre) }})
                &nbsp; <span class="sw"></span> after discussion ({{ s.closed_round_result?.total ?? histTotal() }})
              </p>
            } @else {
              <p class="total">{{ s.closed_round_result?.total ?? histTotal() }} answer(s)</p>
            }
          } @else if (s.closed_round?.phase === 'pre' && s.closed_round_question?.mode === 'twice_end') {
            <p class="phase">Discuss</p>
            <p class="waiting">
              Talk it over with your neighbours. You will answer again, and the
              results from both rounds are shown after that.
            </p>
          } @else {
            <p class="waiting">Waiting for the teacher to open a question…</p>
          }
        }
      } @else if (error()) {
        <p class="error">{{ error() }}</p>
      } @else {
        <p>Loading…</p>
      }
    </div>
  `,
  styles: [
    `
      .wrap { max-width: 30rem; margin: 1.5rem auto; padding: 1rem; }
      .anon { font-size: 0.85rem; color: #666; margin-top: -0.5rem; }
      .phase { font-weight: 600; color: #2c7; text-transform: uppercase; font-size: 0.8rem; }
      .qtext { font-size: 1.2rem; margin: 0.5rem 0 1rem; }
      /* Figures, <pre> and tables in rendered Markdown are sized in
         styles.scss — a rule written here would not reach them. */
      .qtext pre { background: #f5f5f5; padding: 0.5rem; border-radius: 4px; }
      .qtext code { background: #f5f5f5; padding: 0.1rem 0.25rem; border-radius: 3px; }
      .qtext th, .qtext td { border: 1px solid #ddd; padding: 0.2rem 0.4rem; }
      img { max-width: 100%; height: auto; border-radius: 6px; }
      .choices { display: flex; flex-direction: column; gap: 0.6rem; }
      .choice { padding: 1rem; text-align: left; border: 2px solid #ccc; border-radius: 8px;
                background: #fff; font-size: 1rem; }
      .choice.selected { border-color: #2c7; background: #eafaf1; }
      .waiting { color: #777; text-align: center; margin-top: 2rem; }
      .saved { color: #2c7; margin-top: 1rem; }
      .rename { text-align: center; margin-top: 2rem; }
      .rename button { background: none; border: none; color: #777; text-decoration: underline; }
      .sending { color: #777; margin-top: 1rem; }
      .error { color: #c0392b; }
      .hist { display: flex; flex-direction: column; gap: 0.7rem; margin-top: 0.5rem; }
      .hist .row.mine .label { font-weight: 700; }
      .hist .label { display: block; margin-bottom: 0.2rem; }
      .bar-line { display: flex; align-items: center; gap: 0.5rem; }
      .bar { height: 1.2rem; background: #2c7; border-radius: 3px; min-width: 2px; }
      .bar.first { background: #9bd; height: 0.8rem; }
      .sw { display: inline-block; width: 0.8rem; height: 0.8rem; background: #2c7;
            border-radius: 2px; vertical-align: middle; }
      .sw.first { background: #9bd; }
      .n { color: #555; font-size: 0.9rem; min-width: 1.2rem; }
      .total { color: #777; font-size: 0.9rem; margin-top: 0.8rem; }
      .how { color: #666; font-size: 0.9rem; margin: 0.2rem 0 0.6rem; }
      .box { margin-right: 0.3rem; }
      .send { margin-top: 0.8rem; padding: 0.8rem 1.4rem; font-size: 1rem; border-radius: 8px;
              border: none; background: #2c7a51; color: #fff; }
      .send:disabled { background: #bbb; }
      .ranking { padding-left: 1.6rem; margin: 0; }
      .ranking li { display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem 0;
                    border-bottom: 1px solid #eee; }
      .ranking .rtext { flex: 1; }
      .ranking button { width: 2.6rem; height: 2.6rem; font-size: 1.1rem; border-radius: 6px;
                        border: 1px solid #ccc; background: #fff; }
      .numrow { display: flex; align-items: center; gap: 0.5rem; }
      .num, .word, .text { font-size: 1.2rem; padding: 0.6rem; border: 2px solid #ccc;
                           border-radius: 8px; width: 100%; box-sizing: border-box; font-family: inherit; }
      .word { display: block; margin: 0.4rem 0; }
      .unit { font-size: 1.1rem; color: #555; }
      .scale { display: flex; gap: 0.4rem; }
      .step { flex: 1; padding: 0.9rem 0; font-size: 1.1rem; border: 2px solid #ccc;
              border-radius: 8px; background: #fff; }
      .step.selected { border-color: #2c7; background: #eafaf1; font-weight: 700; }
      .ends { display: flex; justify-content: space-between; color: #666; font-size: 0.85rem;
              margin-top: 0.3rem; }
      .tap { position: relative; display: inline-block; max-width: 100%; cursor: crosshair;
             touch-action: manipulation; }
      .tap img { display: block; max-width: 100%; height: auto; user-select: none; }
      .marker { position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px;
                border-radius: 50%; background: rgba(44, 122, 81, 0.75); border: 3px solid #fff;
                box-shadow: 0 0 0 1px #2c7a51; pointer-events: none; }
    `,
  ],
})
export class StudentSessionComponent implements OnInit, OnDestroy {
  state = signal<SessionState | null>(null);
  selected = signal<number | null>(null);
  /** The answer the server holds for the open round, any kind. */
  sent = signal<AnswerInput | null>(null);
  // Drafts for the kinds that are typed or arranged before sending.
  picks = signal<number[]>([]);
  order = signal<number[]>([]);
  numberDraft = signal('');
  wordDraft = signal<string[]>(['']);
  textDraft = signal('');
  /** The round the drafts belong to; a new round starts them afresh. */
  private draftRound: number | null = null;
  error = signal<string>('');
  /** In a competition: this student's nickname, score and place. */
  standing = signal<Standing | null>(null);
  standingLoaded = signal(false);
  /** The closed round `standing` was fetched after, so a stale verdict is never shown. */
  standingRound = signal<number | null>(null);
  renaming = signal(false);
  nicknameError = signal('');
  nicknameBusy = signal(false);
  /** When the last state arrived, and the time now, for the competition clock. */
  private receivedAt = 0;
  private now = signal(Date.now());
  private clock?: ReturnType<typeof setInterval>;
  private standingTimer?: ReturnType<typeof setTimeout>;
  sending = signal(false);
  sendError = signal<string>('');
  private code = '';
  private teardown?: () => void;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private route: ActivatedRoute,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.code = this.route.snapshot.paramMap.get('code') || '';
    // Do not decide on auth from auth.user() here: this page is loaded fresh
    // when a student scans the QR code, and the session lookup that populates
    // it has not resolved yet, so an already-logged-in student would be
    // bounced to the login page every time. Ask the server instead and treat
    // 401 as "needs login".
    this.resync();
    // Follow live state changes; also resync on connect since events sent
    // while disconnected are missed.
    this.teardown = this.api.streamState(this.code, (s) => this.applyState(s));
  }

  ngOnDestroy(): void {
    this.teardown?.();
    if (this.clock) clearInterval(this.clock);
    clearTimeout(this.standingTimer);
  }

  /** Milliseconds left on the open question's clock, by the server's reckoning. */
  clockLeft(): number {
    return msLeft(this.state(), this.receivedAt, this.now());
  }

  chooseNickname(nickname: string): void {
    this.nicknameBusy.set(true);
    this.nicknameError.set('');
    this.api.setNickname(this.code, nickname).subscribe({
      next: ({ nickname: saved }) => {
        this.nicknameBusy.set(false);
        this.renaming.set(false);
        this.standing.update((st) => (st ? { ...st, nickname: saved } : st));
        this.loadStanding(this.state()?.closed_round?.id ?? null);
      },
      error: (err) => {
        this.nicknameBusy.set(false);
        this.nicknameError.set(err?.error?.detail ?? 'Could not save that nickname.');
      },
    });
  }

  private loadStanding(afterRound: number | null): void {
    this.api.standing(this.code).subscribe({
      next: (st) => {
        this.standing.set(st);
        this.standingRound.set(afterRound);
        this.standingLoaded.set(true);
      },
      error: () => this.standingLoaded.set(true),
    });
  }

  /**
   * Keep the competition's side of the page current: the clock while a
   * question is open, and the standing once one closes — fetched after a
   * random pause, because every phone in the room learns of the close at once.
   */
  private followCompetition(s: SessionState): void {
    if (!this.clock) {
      this.clock = setInterval(() => this.now.set(Date.now()), CLOCK_TICK_MS);
    }
    if (!this.standingLoaded()) {
      this.loadStanding(s.open_round ? null : (s.closed_round?.id ?? null));
      return;
    }
    const closed = s.open_round ? null : (s.closed_round?.id ?? null);
    if (closed !== null && closed !== this.standingRound()) {
      clearTimeout(this.standingTimer);
      this.standingTimer = setTimeout(
        () => this.loadStanding(closed),
        Math.random() * STANDING_SPREAD_MS,
      );
    }
  }

  /**
   * Answers for one choice, once the round is closed and the histogram is in.
   * `hist` defaults to the closed round's own; pass the pre histogram to read
   * the first round of a question asked twice.
   */
  count(choiceId: number, hist = this.state()?.closed_round_histogram): number {
    return hist ? hist[choiceId] || 0 : 0;
  }

  histTotal(hist = this.state()?.closed_round_histogram): number {
    if (!hist) return 0;
    return Object.values(hist).reduce((sum, n) => sum + n, 0);
  }

  /**
   * Bar width as a percentage of those who answered, 0 when nobody did.
   * `respondents` comes from the round's result: for a several-choice
   * question the counts add up to more than the number of students.
   */
  pct(choiceId: number, hist = this.state()?.closed_round_histogram, respondents?: number): number {
    const total = respondents ?? this.histTotal(hist);
    return total === 0 ? 0 : (this.count(choiceId, hist) / total) * 100;
  }

  private resync(): void {
    this.api.sessionState(this.code).subscribe({
      next: (s) => this.applyState(s),
      error: (err) => {
        if (err?.status === 401) {
          // Send them to log in, then straight back to this session.
          this.router.navigate(['/login'], {
            queryParams: { next: `/s/${this.code}` },
          });
          return;
        }
        this.error.set('Session not found.');
      },
    });
  }

  private applyState(s: SessionState): void {
    this.receivedAt = Date.now();
    this.state.set(s);
    if (s.competition) this.followCompetition(s);
    // While a round is open the server tells us our own answer; trust it over
    // local state. Once it closes the server no longer sends it, and the last
    // one is kept so the results can mark what this student picked.
    if (s.open_round || !s.closed_round) {
      this.selected.set(s.my_choice_id);
      this.sent.set(s.my_answer ?? (s.my_choice_id ? { choice_id: s.my_choice_id } : null));
    }
    const roundId = s.open_round?.id ?? null;
    if (roundId !== this.draftRound) {
      this.draftRound = roundId;
      this.resetDrafts(s.question, s.my_answer ?? null);
    }
  }

  /** Start the drafts from the student's saved answer, or empty. */
  private resetDrafts(q: Question | null, mine: AnswerInput | null): void {
    if (!q) return;
    const ids = q.choices.map((c) => c.id);
    this.picks.set(kindOf(q) === 'multi' ? (mine?.choice_ids ?? []) : []);
    this.order.set(kindOf(q) === 'rank' && mine?.choice_ids?.length ? mine.choice_ids : ids);
    this.numberDraft.set(kindOf(q) === 'number' && mine?.number !== undefined ? `${mine.number}` : '');
    const n = this.maxWords(q);
    const words = [...(mine?.words ?? [])];
    this.wordDraft.set(Array.from({ length: n }, (_, i) => words[i] ?? ''));
    this.textDraft.set(mine?.text ?? '');
  }

  kind(q: Question): QuestionKind {
    return kindOf(q);
  }

  /** Choice and several-choice results keep their bar chart (and the student's own pick). */
  isBars(q: Question): boolean {
    return kindOf(q) === 'choice' || kindOf(q) === 'multi';
  }

  /** The choices this student ticked, for marking them in the results. */
  mine(): number[] {
    return this.sent()?.choice_ids ?? [];
  }

  saved(): boolean {
    return this.selected() !== null || this.sent() !== null;
  }

  choiceText(q: Question, id: number): string {
    return q.choices.find((c) => c.id === id)?.text ?? '';
  }

  scaleValues(q: Question): number[] {
    const [lo, hi] = scaleRange(q);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }

  maxWords(q: Question): number {
    return q.settings?.max_words ?? 3;
  }

  maxLength(q: Question): number {
    return q.settings?.max_length ?? 500;
  }

  numberSent(): number | null {
    return this.sent()?.number ?? null;
  }

  pointSent(): [number, number] | null {
    return this.sent()?.point ?? null;
  }

  togglePick(id: number): void {
    this.picks.update((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  move(index: number, delta: number): void {
    this.order.update((o) => {
      const next = [...o];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  }

  setWord(index: number, value: string): void {
    this.wordDraft.update((w) => w.map((x, i) => (i === index ? value : x)));
  }

  hasWords(): boolean {
    return this.wordDraft().some((w) => w.trim());
  }

  sendWords(): void {
    if (this.hasWords()) this.send({ words: this.wordDraft().filter((w) => w.trim()) });
  }

  sendNumber(): void {
    const x = parseFloat(this.numberDraft().replace(',', '.'));
    if (Number.isFinite(x)) this.send({ number: x });
    else this.sendError.set('That is not a number.');
  }

  /** Where on the figure the student tapped, as fractions of its width and height. */
  tap(event: MouseEvent): void {
    const img = (event.currentTarget as HTMLElement).querySelector('img');
    if (!img) return;
    const box = img.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    this.send({ point: [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000] });
  }

  /**
   * Submit an answer, retrying if the server is merely busy.
   *
   * A whole class taps at once, so the server may turn a submission away
   * (503) to keep from starving itself. That is a "wait a moment", not a
   * refusal — but the student cannot tell the difference from a spinner, and
   * the submission window is short, so the phone retries rather than asking
   * them to notice and tap again. The waits are staggered by a random amount
   * because the reason for the 503 was everyone acting in unison; retrying in
   * unison would recreate it.
   *
   * Only a busy server and a dropped connection are retried. Every other
   * error means the server has an opinion — most often that the round has
   * closed — and the answer to that is to go and get the truth, not to insist.
   *
   * A 502 or 504 counts as a dropped connection. It is written by Serve's
   * proxy, not by this app, and says the proxy lost its way to the app: a
   * load test at the deployment got 502s under a burst and saw the proxy cut
   * every open connection at once. Re-sending is safe even if the first try
   * was recorded, because an answer is one row per student per round and a
   * repeat overwrites it with the same choice.
   */
  answer(choiceId: number, attempt = 0): void {
    this.send({ choice_id: choiceId }, attempt);
  }

  /** Submit an answer of any kind; see `answer()` for the retry rules. */
  send(body: AnswerInput, attempt = 0): void {
    this.sending.set(true);
    this.sendError.set('');
    this.api.submitAnswer(this.code, body.choice_id !== undefined ? body.choice_id : body).subscribe({
      next: () => {
        if (body.choice_id !== undefined) this.selected.set(body.choice_id);
        this.sent.set(body);
        this.sending.set(false);
      },
      error: (err) => {
        const busy = RETRYABLE_STATUSES.includes(err?.status);
        if (busy && attempt < SEND_RETRIES) {
          const wait = SEND_BACKOFF_MS * Math.pow(2, attempt) * (0.5 + Math.random());
          setTimeout(() => this.send(body, attempt + 1), wait);
          return;
        }
        this.sending.set(false);
        if (busy) {
          // Say so plainly and leave the choices tappable: the answer was not
          // recorded, and the student is the only one who can send it again.
          this.sendError.set('Too many at once — tap your answer again.');
          return;
        }
        if (err?.error?.detail === 'Choose a nickname first') {
          // The teacher took the nickname down: ask for another.
          this.standing.update((st) => (st ? { ...st, nickname: null } : st));
          this.sendError.set('');
          return;
        }
        if (err?.status === 409 && err?.error?.detail && err.error.detail !== 'No round is open'
            && err.error.detail !== 'This round is closed') {
          // The answer does not fit the question (out of range, too long…):
          // say why and let them fix it.
          this.sendError.set(err.error.detail);
          return;
        }
        this.resync(); // round probably closed; refresh truth
      },
    });
  }
}
