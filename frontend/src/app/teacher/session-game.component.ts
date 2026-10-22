import { Component, HostListener, OnDestroy, OnInit, computed, effect, signal } from '@angular/core';

import { ApiService } from '../api.service';
import { Leaderboard, LeaderboardEntry, Question, kindOf, msLeft } from '../models';
import { ResultViewComponent } from '../shared/result-view.component';
import { GameLeaderboardComponent } from './game-leaderboard.component';
import { GamePodiumComponent } from './game-podium.component';
import { GameTilesComponent } from './game-tiles.component';
import { JoinQrComponent } from './join-qr.component';
import { SessionFeed } from './session-feed.service';

/** Polling while waiting for players, and for answers during a question. */
const LOBBY_POLL_MS = 2000;
const ANSWER_POLL_MS = 1000;

type Stage = 'lobby' | 'question' | 'result' | 'leaderboard' | 'podium';

/**
 * A competition's projected screen, driven from the screen itself.
 *
 * Lobby (QR code and the nicknames arriving) → question (choices as coloured
 * tiles and a countdown) → result (how the room answered, the right one
 * marked) → leaderboard (the top five, sliding into their new places as the
 * scores count up) → next question, and after the last a podium.
 *
 * Only nicknames appear, never names, and nothing about how the room is
 * answering is shown while the clock is running — just how many have.
 * The space bar or → advances, so a presentation clicker can drive it.
 */
@Component({
  selector: 'app-teacher-session-game',
  standalone: true,
  imports: [
    GameLeaderboardComponent,
    GamePodiumComponent,
    GameTilesComponent,
    JoinQrComponent,
    ResultViewComponent,
  ],
  template: `
    <div class="game">
      @switch (stage()) {
        @case ('lobby') {
          <div class="lobby">
            <div class="join-card">
              <app-join-qr />
              <p class="join-how">
                Scan, or go to <strong>{{ host() }}</strong><br />
                and enter <span class="code">{{ feed.code() }}</span>
              </p>
            </div>
            <div class="waiting-room">
              <h1>{{ feed.state()?.quiz_title }}</h1>
              <p class="players-count">
                <span class="big">{{ board()?.players ?? 0 }}</span>
                {{ (board()?.players ?? 0) === 1 ? 'player' : 'players' }}
              </p>
              <div class="bubbles">
                @for (e of board()?.entries ?? []; track e.participant_id) {
                  <span class="bubble" title="Click to remove this nickname">
                    {{ e.nickname }}
                    <button type="button" class="kick" (click)="kick(e)" aria-label="Remove nickname">×</button>
                  </span>
                } @empty {
                  <span class="hint">Waiting for players to pick a nickname…</span>
                }
              </div>
              <button class="go" (click)="advance()" [disabled]="!nextQuestion()">
                Start ▶
              </button>
            </div>
          </div>
        }

        @case ('question') {
          @if (liveQuestion(); as q) {
            <header class="top">
              <span class="counter">Question {{ numberOf(q) }} of {{ feed.questions().length }}</span>
              <span class="joinline">{{ host() }} · <b>{{ feed.code() }}</b></span>
            </header>
            <div class="qcard"><div class="qtext" [innerHTML]="q.text_html"></div></div>
            <div class="midrow">
              <div class="clock" [class.hurry]="secondsLeft() <= 5">
                <svg viewBox="0 0 100 100" aria-hidden="true">
                  <circle class="track" cx="50" cy="50" r="44" />
                  <circle class="ring" cx="50" cy="50" r="44"
                          [style.stroke-dashoffset]="ringOffset()" />
                </svg>
                <span class="secs">{{ secondsLeft() }}</span>
              </div>
              @if (q.image_url && kind(q) !== 'point') {
                <img class="figure" [src]="q.image_url" alt="" />
              }
              <div class="answers-in">
                <span class="big">{{ answered() }}</span>
                {{ answered() === 1 ? 'answer' : 'answers' }}
              </div>
            </div>
            @if (hasTiles(q)) {
              <app-game-tiles [question]="q" />
            } @else {
              <p class="phone-hint">Answer on your phone</p>
            }
            <div class="actions">
              <button class="ghost" (click)="skip()">Stop the clock ⏭</button>
            </div>
          }
        }

        @case ('result') {
          @if (resultQuestion(); as q) {
            <header class="top">
              <span class="counter">Question {{ numberOf(q) }} of {{ feed.questions().length }}</span>
              <span class="joinline">{{ host() }} · <b>{{ feed.code() }}</b></span>
            </header>
            <div class="qcard small"><div class="qtext" [innerHTML]="q.text_html"></div></div>
            @if (hasTiles(q)) {
              <app-game-tiles [question]="q" [counts]="feed.state()?.closed_round_histogram ?? {}" />
            } @else {
              @if (feed.state()?.closed_round_result; as res) {
                <div class="other-result">
                  <app-result-view [question]="q" [pre]="res" [once]="true" [revealCorrect]="true" />
                </div>
              }
            }
            <div class="actions">
              <button class="go" (click)="advance()">Leaderboard ▶</button>
            </div>
          }
        }

        @case ('leaderboard') {
          <h1 class="board-title">Leaderboard</h1>
          <app-game-leaderboard [data]="board()" />
          <div class="actions">
            @if (nextQuestion()) {
              <button class="go" (click)="advance()">Next question ▶</button>
            } @else {
              <button class="go gold" (click)="advance()">🏆 Final results</button>
            }
          </div>
        }

        @case ('podium') {
          <h1 class="board-title">🏆 Winners 🏆</h1>
          <app-game-podium [data]="board()" />
        }
      }
      @if (actionError()) { <p class="error">{{ actionError() }}</p> }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .game {
        position: relative; overflow: hidden; min-height: calc(100vh - 4rem);
        margin-top: 0.8rem; padding: 1.5rem 2rem 2rem; box-sizing: border-box;
        color: #fff; font-family: 'Montserrat', 'Segoe UI', system-ui, sans-serif;
        background:
          radial-gradient(circle at 15% 20%, rgba(255,255,255,0.08) 0 8rem, transparent 8rem),
          radial-gradient(circle at 85% 75%, rgba(255,255,255,0.06) 0 12rem, transparent 12rem),
          linear-gradient(135deg, #46178f 0%, #2b0f5c 100%);
      }
      h1 { margin: 0; font-weight: 800; }
      .error { position: absolute; bottom: 0.5rem; left: 2rem; background: #fff; color: #c0392b;
               padding: 0.3rem 0.6rem; border-radius: 6px; }

      .go { font-size: 1.4rem; font-weight: 800; padding: 0.8rem 2.2rem; border: none;
            border-radius: 8px; background: #fff; color: #46178f; cursor: pointer;
            box-shadow: 0 5px 0 rgba(0,0,0,0.25); }
      .go:disabled { opacity: 0.5; cursor: default; }
      .go.gold { background: #ffcc00; color: #3a2500; }
      .ghost { background: rgba(255,255,255,0.15); color: #fff; border: 1px solid rgba(255,255,255,0.4);
               border-radius: 8px; padding: 0.5rem 1rem; font-weight: 600; cursor: pointer; }
      .actions { display: flex; justify-content: flex-end; margin-top: 1rem; }

      .lobby { display: flex; gap: 2.5rem; align-items: center; justify-content: center;
               flex-wrap: wrap; min-height: 70vh; }
      .join-card { background: #fff; color: #222; border-radius: 16px; padding: 1.2rem;
                   text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
      .join-how { margin: 0.6rem 0 0; line-height: 1.7; }
      .code { font-size: 2rem; font-weight: 800; letter-spacing: 0.12em; color: #46178f; }
      .waiting-room { flex: 1; min-width: 18rem; max-width: 40rem; }
      .waiting-room h1 { font-size: 2.4rem; }
      .players-count { font-size: 1.3rem; margin: 0.6rem 0 1rem; }
      .big { font-size: 3rem; font-weight: 800; vertical-align: middle; margin-right: 0.3rem; }
      .bubbles { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1.6rem; min-height: 3rem; }
      .bubble { background: #fff; color: #333; font-weight: 700; padding: 0.45rem 0.9rem;
                border-radius: 999px; animation: pop 0.4s cubic-bezier(.2,1.6,.4,1) both;
                display: inline-flex; align-items: center; gap: 0.3rem; }
      .kick { border: none; background: none; color: #bbb; font-size: 1.1rem; cursor: pointer;
              padding: 0; line-height: 1; visibility: hidden; }
      .bubble:hover .kick { visibility: visible; }
      .kick:hover { color: #c0392b; }
      .hint { opacity: 0.7; font-style: italic; }

      .top { display: flex; justify-content: space-between; align-items: center; font-weight: 700; }
      .counter { background: rgba(255,255,255,0.15); padding: 0.3rem 0.8rem; border-radius: 999px; }
      .joinline { opacity: 0.85; }
      .qcard { background: #fff; color: #222; border-radius: 10px; padding: 1.2rem 1.6rem;
               margin: 1rem auto; max-width: 60rem; text-align: center; font-size: 2rem;
               font-weight: 700; box-shadow: 0 6px 0 rgba(0,0,0,0.2); animation: drop 0.5s ease-out both; }
      .qcard.small { font-size: 1.4rem; padding: 0.8rem 1.2rem; }
      .qtext :is(p) { margin: 0.2rem 0; }
      .midrow { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
                min-height: 9rem; margin: 0.5rem 0 1rem; }
      .figure { max-height: 14rem; max-width: 50%; border-radius: 8px; background: #fff; }
      .clock { position: relative; width: 8rem; height: 8rem; flex-shrink: 0; }
      .clock svg { width: 100%; height: 100%; transform: rotate(-90deg); }
      .clock circle { fill: none; stroke-width: 9; }
      .clock .track { stroke: rgba(255,255,255,0.18); }
      .clock .ring { stroke: #ffcc00; stroke-linecap: round; stroke-dasharray: 276.46;
                     transition: stroke-dashoffset 0.1s linear; }
      .clock.hurry .ring { stroke: #ff4d6d; }
      .clock.hurry .secs { animation: pulse 0.5s ease-in-out infinite alternate; }
      .secs { position: absolute; inset: 0; display: grid; place-items: center;
              font-size: 3rem; font-weight: 800; }
      .answers-in { text-align: center; font-weight: 700; font-size: 1.2rem; }
      .answers-in .big { display: block; margin: 0; }
      .phone-hint { text-align: center; font-size: 2rem; font-weight: 700; margin-top: 3rem; }

      .other-result { background: #fff; color: #222; border-radius: 10px; padding: 1rem;
                      max-width: 50rem; margin: 0 auto; }

      .board-title { text-align: center; font-size: 2.6rem; margin: 0.5rem 0 1.5rem;
                     animation: drop 0.5s ease-out both; }
      @keyframes pop { from { transform: scale(0.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      @keyframes drop { from { transform: translateY(-1.5rem); opacity: 0; } to { transform: none; opacity: 1; } }
      @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.12); } }
      @media (prefers-reduced-motion: reduce) {
        .game *, .game *::before { animation: none !important; transition: none !important; }
      }
    `,
  ],
})
export class TeacherSessionGameComponent implements OnInit, OnDestroy {
  readonly board = signal<Leaderboard | null>(null);
  readonly answered = signal(0);
  readonly actionError = signal('');
  /** Which of the between-questions screens is up, once a round has closed. */
  private readonly between = signal<'result' | 'leaderboard' | 'podium'>('result');
  private readonly now = signal(Date.now());

  private seenClosedRound: number | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private frame = 0;

  readonly stage = computed<Stage>(() => {
    if (this.feed.openRound()) return 'question';
    if (!this.feed.started()) return 'lobby';
    return this.between();
  });

  readonly liveQuestion = computed<Question | null>(() => {
    const open = this.feed.openRound();
    return open ? (this.feed.questions().find((q) => q.id === open.question_id) ?? null) : null;
  });

  /** The teacher's copy of the question just asked: it knows which choice is right. */
  readonly resultQuestion = computed<Question | null>(() => {
    const id = this.feed.state()?.closed_round?.question_id;
    return this.feed.questions().find((q) => q.id === id) ?? null;
  });

  readonly nextQuestion = computed<Question | null>(
    () => this.feed.questions().find((q) => !this.feed.ran(q, 'pre')) ?? null,
  );

  readonly secondsLeft = computed(() =>
    Math.ceil(msLeft(this.feed.state(), this.feed.receivedAt(), this.now()) / 1000),
  );

  /** How much of the ring is used up, as an SVG dash offset. */
  readonly ringOffset = computed(() => {
    const limit = (this.feed.state()?.time_limit ?? 20) * 1000;
    const left = msLeft(this.feed.state(), this.feed.receivedAt(), this.now());
    return 276.46 * (1 - Math.min(1, left / limit));
  });

  constructor(public feed: SessionFeed, private api: ApiService) {
    // A newly closed round always opens on its result, wherever the screen was.
    effect(() => {
      const closed = this.feed.state()?.closed_round;
      if (this.feed.openRound() || !closed || closed.id === this.seenClosedRound) return;
      const first = this.seenClosedRound === null;
      this.seenClosedRound = closed.id;
      // Opened mid-game (a reload): land on the leaderboard rather than
      // replaying a result the room has already seen.
      this.between.set(first && !this.nextQuestion() ? 'leaderboard' : 'result');
      this.loadBoard();
    });
  }

  ngOnInit(): void {
    this.loadBoard();
    this.timers.push(
      setInterval(() => {
        if (this.stage() === 'lobby') this.loadBoard();
      }, LOBBY_POLL_MS),
      setInterval(() => {
        if (this.stage() === 'question') {
          this.api.liveCount(this.feed.code()).subscribe((l) => this.answered.set(l.answered));
        }
      }, ANSWER_POLL_MS),
    );
    const tick = () => {
      this.now.set(Date.now());
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  ngOnDestroy(): void {
    this.timers.forEach(clearInterval);
    cancelAnimationFrame(this.frame);
  }

  /** Space or → moves the game on, so a presentation clicker can drive it. */
  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return;
    if (event.key === ' ' || event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      if (this.stage() !== 'question' && this.stage() !== 'podium') this.advance();
    }
  }

  advance(): void {
    this.actionError.set('');
    switch (this.stage()) {
      case 'lobby':
        this.openNext();
        break;
      case 'result':
        this.showBoard();
        break;
      case 'leaderboard':
        if (this.nextQuestion()) this.openNext();
        else this.showPodium();
        break;
    }
  }

  skip(): void {
    const open = this.feed.openRound();
    if (!open) return;
    this.api.closeRound(this.feed.code(), open.id).subscribe({
      next: () => this.feed.refreshState(),
      error: () => this.feed.refreshState(),
    });
  }

  kick(entry: LeaderboardEntry): void {
    this.api.clearNickname(this.feed.code(), entry.participant_id).subscribe({
      next: () => this.loadBoard(),
      error: () => this.actionError.set('Could not remove that nickname.'),
    });
  }

  private openNext(): void {
    const q = this.nextQuestion();
    if (!q) return;
    this.answered.set(0);
    this.api.openRound(this.feed.code(), q.id, 'pre').subscribe({
      next: () => this.feed.refreshState(),
      error: (err) => {
        this.actionError.set(err?.error?.detail ?? 'Could not start the question.');
        this.feed.refreshState();
      },
    });
  }

  private showBoard(): void {
    // Cleared first, so the leaderboard animates from this question's numbers
    // rather than flashing the last ones.
    this.board.set(null);
    this.between.set('leaderboard');
    this.loadBoard();
  }

  private showPodium(): void {
    this.between.set('podium');
    this.loadBoard();
  }

  private loadBoard(then?: () => void): void {
    if (!this.feed.code()) return;
    this.api.leaderboard(this.feed.code()).subscribe({
      next: (b) => {
        this.board.set(b);
        then?.();
      },
    });
  }

  numberOf(q: Question): number {
    return this.feed.questions().findIndex((x) => x.id === q.id) + 1;
  }

  kind(q: Question) {
    return kindOf(q);
  }

  hasTiles(q: Question): boolean {
    const k = kindOf(q);
    return k === 'choice' || k === 'multi';
  }

  host(): string {
    try {
      return new URL(this.feed.joinUrl()).host;
    } catch {
      return '';
    }
  }
}
