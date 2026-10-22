import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { Standing } from '../models';
import {
  AnswerTilesComponent,
  CountdownBarComponent,
  GameVerdictComponent,
  NicknameFormComponent,
} from '../student/competition.components';
import {
  BOTS,
  BotAnswer,
  RoundOutcome,
  botAnswers,
  buildBoard,
  demoQuestions,
  points,
  seeded,
} from './demo-game';
import { DemoProjectorComponent, DemoStage } from './demo-projector.component';

const DEFAULT_SECONDS = 15;
/** How often the clock and the answer count redraw. */
const TICK_MS = 100;
/** The made-up players drift into the lobby this far apart. */
const JOIN_EVERY_MS = 450;

/**
 * Competition mode, played in the browser: the visitor's phone on the left,
 * the projected screen on the right, against eight made-up players. Nothing
 * is sent anywhere. `?seconds=` sets the clock (5–30) and `?seed=` repeats a
 * game exactly.
 */
@Component({
  selector: 'app-demo-competition',
  standalone: true,
  imports: [
    RouterLink,
    AnswerTilesComponent,
    CountdownBarComponent,
    DemoProjectorComponent,
    GameVerdictComponent,
    NicknameFormComponent,
  ],
  template: `
    <div class="wrap">
      <h1>Try competition mode</h1>
      <p class="lede">
        A Kahoot-style game: every question once against the clock, points for being right and
        quick, and a leaderboard of nicknames between questions. Play on the phone (left) against
        eight made-up classmates; you also press the buttons on the projected screen (right), as the
        teacher would. Nothing is sent or stored.
        <a routerLink="/demo">← the other question kinds</a>
      </p>
      <div class="panes">
        <section>
          <p class="label">Your phone</p>
          <div class="screen">
            @if (!you()) {
              <app-nickname-form [error]="nicknameError()" (chosen)="join($event)" />
            } @else {
              <p class="me">🏆 Playing as <b>{{ you() }}</b></p>
              @switch (stage()) {
                @case ('lobby') {
                  <p class="wait">You're in! Press <b>Start</b> on the big screen when you are ready.</p>
                }
                @case ('question') {
                  <div class="qtext" [innerHTML]="question().text_html"></div>
                  <app-countdown-bar [msLeft]="msLeft()" [limitSeconds]="limitMs / 1000" />
                  <app-answer-tiles [choices]="question().choices" [picked]="yourPick()"
                                    [locked]="yourPick() !== null" (pick)="pick($event)" />
                  @if (yourPick() !== null) { <p class="ok">Locked in! Watch the big screen. 🤞</p> }
                }
                @case ('podium') {
                  <p class="final">Game over — you finished
                    <b>{{ standing().rank }}{{ suffix(standing().rank ?? 0) }}</b> of {{ standing().players }}
                    with <b>{{ standing().score }}</b> points.</p>
                }
                @default {
                  <app-game-verdict [standing]="standing()" />
                }
              }
            }
          </div>
        </section>
        <section>
          <p class="label">Projector</p>
          <app-demo-projector
            [stage]="stage()" [players]="joined()" [you]="you()" [question]="question()"
            [number]="index() + 1" [total]="questions.length" [msLeft]="msLeft()"
            [answered]="answered()" [counts]="counts()" [board]="board()"
            (advance)="advance()" (again)="restart()" />
        </section>
      </div>
      <p class="foot">
        Points: 1000 for a right answer given at once, falling to 500 at the buzzer; nothing for a
        wrong one. The first tap counts. A real game is started with <b>🏆 Competition</b> on the
        teacher's dashboard.
      </p>
    </div>
  `,
  styles: [
    `
      .wrap { max-width: 72rem; margin: 0 auto; padding: 1.2rem 16px 3rem; }
      h1 { margin: 0.2rem 0 0.4rem; color: #46178f; }
      .lede, .foot { max-width: 50rem; color: #444; }
      .foot { font-size: 0.85rem; color: #777; margin-top: 1.5rem; }
      .panes { display: grid; grid-template-columns: minmax(0, 22rem) minmax(0, 1fr); gap: 1.5rem;
               align-items: start; margin-top: 1rem; }
      @media (max-width: 860px) { .panes { grid-template-columns: minmax(0, 1fr); } }
      .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.07em; color: #777;
               margin: 0 0 0.4rem; }
      .screen { border: 10px solid #222; border-radius: 26px; padding: 1rem; min-height: 28rem; background: #fff; }
      .me { font-size: 0.9rem; color: #555; margin-top: 0; }
      .qtext { font-size: 1.15rem; margin-bottom: 0.4rem; }
      .wait, .final { text-align: center; color: #555; margin-top: 3rem; font-size: 1.1rem; }
      .ok { color: #26890c; text-align: center; font-weight: 700; }
    `,
  ],
})
export class DemoCompetitionComponent implements OnInit, OnDestroy {
  readonly limitMs: number;
  private seed: number;
  private rng: () => number;
  questions: ReturnType<typeof demoQuestions>;

  readonly you = signal('');
  readonly nicknameError = signal('');
  readonly joined = signal<string[]>([]);
  readonly stage = signal<DemoStage>('lobby');
  readonly index = signal(0);
  readonly outcomes = signal<RoundOutcome[]>([]);
  readonly yourPick = signal<number | null>(null);
  private yourAfterMs = 0;
  private bots: BotAnswer[] = [];
  private startedAt = 0;
  private readonly now = signal(Date.now());
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ticker?: ReturnType<typeof setInterval>;

  readonly question = computed(() => this.questions[this.index()]);

  readonly msLeft = computed(() =>
    this.stage() === 'question' ? Math.max(0, this.limitMs - (this.now() - this.startedAt)) : 0,
  );

  readonly answered = computed(() => {
    const elapsed = this.now() - this.startedAt;
    return this.bots.filter((b) => b.afterMs <= elapsed).length + (this.yourPick() !== null ? 1 : 0);
  });

  readonly counts = computed(() => {
    const last = this.outcomes()[this.index()] ?? {};
    const out: Record<number, number> = {};
    for (const o of Object.values(last)) out[o.choiceId] = (out[o.choiceId] ?? 0) + 1;
    return out;
  });

  readonly board = computed(() =>
    buildBoard(this.joined(), this.outcomes(), this.questions.length),
  );

  /** The visitor's place, in the shape a real phone gets from `/standing`. */
  readonly standing = computed<Standing>(() => {
    const b = this.board();
    const mine = b.entries.find((e) => e.nickname === this.you());
    const last = this.outcomes()[this.outcomes().length - 1] ?? {};
    return {
      nickname: this.you(),
      score: mine?.score ?? 0,
      rank: mine?.rank ?? null,
      players: b.players,
      rounds_played: b.rounds_played,
      last_question_id: null,
      last_points: mine?.gained ?? 0,
      last_correct: mine?.last_correct ?? null,
      last_answered: this.you() in last,
    };
  });

  constructor(route: ActivatedRoute) {
    const params = route.snapshot.queryParamMap;
    const seconds = Number(params.get('seconds')) || DEFAULT_SECONDS;
    this.limitMs = Math.min(30, Math.max(5, seconds)) * 1000;
    this.seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e9);
    this.rng = seeded(this.seed);
    this.questions = demoQuestions(this.rng);
  }

  ngOnInit(): void {
    this.fillLobby();
    this.ticker = setInterval(() => {
      this.now.set(Date.now());
      if (this.stage() === 'question') this.maybeClose();
    }, TICK_MS);
  }

  ngOnDestroy(): void {
    this.timers.forEach(clearTimeout);
    clearInterval(this.ticker);
  }

  join(nickname: string): void {
    if (BOTS.some((b) => b.nickname.toLowerCase() === nickname.toLowerCase())) {
      this.nicknameError.set('That nickname is taken — pick another');
      return;
    }
    this.nicknameError.set('');
    this.you.set(nickname);
    this.joined.update((j) => [...j, nickname]);
  }

  pick(choiceId: number): void {
    if (this.yourPick() !== null || this.stage() !== 'question') return;
    this.yourAfterMs = Date.now() - this.startedAt;
    this.yourPick.set(choiceId);
  }

  advance(): void {
    switch (this.stage()) {
      case 'lobby':
        if (this.you()) this.ask(0);
        break;
      case 'result':
        this.stage.set('leaderboard');
        break;
      case 'leaderboard':
        if (this.index() + 1 < this.questions.length) this.ask(this.index() + 1);
        else this.stage.set('podium');
        break;
    }
  }

  restart(): void {
    this.rng = seeded(++this.seed);
    this.questions = demoQuestions(this.rng);
    this.outcomes.set([]);
    this.index.set(0);
    this.stage.set('lobby');
  }

  suffix(n: number): string {
    return n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  }

  private fillLobby(): void {
    BOTS.forEach((bot, i) => {
      this.timers.push(
        setTimeout(() => this.joined.update((j) => [...j, bot.nickname]), (i + 1) * JOIN_EVERY_MS),
      );
    });
  }

  private ask(i: number): void {
    this.index.set(i);
    this.yourPick.set(null);
    this.bots = botAnswers(this.questions[i], this.limitMs, this.rng);
    this.startedAt = Date.now();
    this.now.set(this.startedAt);
    this.stage.set('question');
  }

  /** The clock has run out, or everyone has answered: score the question. */
  private maybeClose(): void {
    const everyone = this.answered() >= this.joined().length;
    if (this.msLeft() > 0 && !everyone) return;
    const q = this.question();
    const isRight = (id: number) => !!q.choices.find((c) => c.id === id)?.is_correct;
    const outcome: RoundOutcome = {};
    for (const b of this.bots) {
      outcome[b.nickname] = {
        choiceId: b.choiceId,
        correct: isRight(b.choiceId),
        points: points(isRight(b.choiceId), b.afterMs, this.limitMs),
      };
    }
    const mine = this.yourPick();
    if (mine !== null) {
      outcome[this.you()] = {
        choiceId: mine,
        correct: isRight(mine),
        points: points(isRight(mine), this.yourAfterMs, this.limitMs),
      };
    }
    this.outcomes.update((o) => [...o.slice(0, this.index()), outcome]);
    this.stage.set('result');
  }
}
