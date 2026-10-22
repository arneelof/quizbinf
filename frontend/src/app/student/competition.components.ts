import { Component, EventEmitter, Input, Output, signal } from '@angular/core';

import { Choice, Standing, gameTile } from '../models';

/**
 * The phone's side of a competition, in pieces the student view puts
 * together: picking a nickname, the coloured answer tiles, the clock, and
 * the verdict after each question.
 */

/** Choose the name to play under; it is what the projected leaderboard shows. */
@Component({
  selector: 'app-nickname-form',
  standalone: true,
  template: `
    <form class="nick" (submit)="$event.preventDefault(); submit()">
      <p class="lead">Pick a nickname</p>
      <p class="why">It is shown on the big screen instead of your name.</p>
      <input #box maxlength="20" autocomplete="off" autocapitalize="off" [value]="current ?? ''"
             (input)="draft.set(box.value)" aria-label="Nickname" placeholder="e.g. BlastMaster" />
      <button [disabled]="!draft().trim() || busy">OK, go!</button>
      @if (error) { <p class="err">{{ error }}</p> }
    </form>
  `,
  styles: [
    `
      .nick { background: #46178f; color: #fff; border-radius: 12px; padding: 1.5rem;
              text-align: center; margin-top: 1rem; }
      .lead { font-size: 1.5rem; font-weight: 800; margin: 0; }
      .why { opacity: 0.8; margin: 0.3rem 0 1rem; font-size: 0.9rem; }
      input { width: 100%; box-sizing: border-box; font-size: 1.3rem; padding: 0.7rem;
              border-radius: 8px; border: none; text-align: center; font-weight: 700; }
      button { margin-top: 0.8rem; width: 100%; padding: 0.8rem; font-size: 1.2rem; font-weight: 800;
               border: none; border-radius: 8px; background: #fff; color: #46178f;
               box-shadow: 0 4px 0 rgba(0, 0, 0, 0.3); }
      button:disabled { opacity: 0.6; }
      .err { background: #fff; color: #c0392b; border-radius: 6px; padding: 0.4rem; margin: 0.8rem 0 0; }
    `,
  ],
})
export class NicknameFormComponent {
  @Input() current: string | null = null;
  @Input() error = '';
  @Input() busy = false;
  @Output() chosen = new EventEmitter<string>();
  readonly draft = signal('');

  submit(): void {
    if (this.draft().trim()) this.chosen.emit(this.draft().trim());
  }
}

/** The time left, as a bar that drains and turns red near the end. */
@Component({
  selector: 'app-countdown-bar',
  standalone: true,
  template: `
    <div class="clock" role="timer" [attr.aria-label]="seconds() + ' seconds left'">
      <div class="track">
        <div class="fill" [class.hurry]="msLeft <= 5000" [style.width.%]="pct()"></div>
      </div>
      <span class="secs" [class.hurry]="msLeft <= 5000">{{ seconds() }}</span>
    </div>
  `,
  styles: [
    `
      .clock { display: flex; align-items: center; gap: 0.6rem; margin: 0.4rem 0 1rem; }
      .track { flex: 1; height: 1.1rem; background: #e6e0f0; border-radius: 999px; overflow: hidden; }
      .fill { height: 100%; background: #46178f; transition: width 0.2s linear; }
      .hurry.fill { background: #e21b3c; }
      .secs { min-width: 2.2rem; text-align: right; font-size: 1.5rem; font-weight: 800; color: #46178f; }
      .hurry.secs { color: #e21b3c; }
    `,
  ],
})
export class CountdownBarComponent {
  @Input() msLeft = 0;
  @Input() limitSeconds = 20;

  seconds(): number {
    return Math.ceil(this.msLeft / 1000);
  }

  pct(): number {
    return Math.min(100, (100 * this.msLeft) / (this.limitSeconds * 1000));
  }
}

/**
 * The choices as big coloured tiles with their shapes, matching the projected
 * screen, so a student can answer by colour without reading the text twice.
 * The first tap counts: after it the tiles lock.
 */
@Component({
  selector: 'app-answer-tiles',
  standalone: true,
  template: `
    <div class="tiles">
      @for (c of choices; track c.id; let i = $index) {
        <button class="tile" [style.background]="tile(i).color" [disabled]="locked"
                [class.picked]="picked === c.id" [class.other]="picked !== null && picked !== c.id"
                (click)="pick.emit(c.id)">
          <span class="shape">{{ tile(i).shape }}</span>
          <span class="text">{{ c.text }}</span>
        </button>
      }
    </div>
  `,
  styles: [
    `
      .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
      .tile { display: flex; flex-direction: column; align-items: center; justify-content: center;
              gap: 0.3rem; min-height: 7.5rem; padding: 0.6rem; border: none; border-radius: 10px;
              color: #fff; font-size: 1rem; font-weight: 700; box-shadow: 0 5px 0 rgba(0, 0, 0, 0.25);
              transition: transform 0.15s, opacity 0.3s; }
      .tile:active:not(:disabled) { transform: translateY(3px); }
      /* Locked, not unavailable: the global faded look for a disabled button
         would dim the pick too, and the pick is what should stand out. */
      .tile:disabled { cursor: default; opacity: 1; }
      .tile.picked { outline: 4px solid #222; transform: scale(1.03); }
      .tile.other { opacity: 0.3; }
      .shape { font-size: 2.4rem; line-height: 1; }
      .text { overflow-wrap: anywhere; }
    `,
  ],
})
export class AnswerTilesComponent {
  @Input({ required: true }) choices!: Choice[];
  @Input() picked: number | null = null;
  @Input() locked = false;
  @Output() pick = new EventEmitter<number>();

  tile(i: number) {
    return gameTile(i);
  }
}

/** After each question: right or wrong, the points, and the student's place. */
@Component({
  selector: 'app-game-verdict',
  standalone: true,
  template: `
    @if (standing; as s) {
      <div class="card" [class.right]="s.last_correct === true" [class.wrong]="s.last_correct === false"
           [class.none]="s.last_answered === false">
        @if (s.last_answered === false) {
          <p class="big">⏰ Time's up</p>
          <p>No answer this time.</p>
        } @else if (s.last_correct === true) {
          <p class="big">✓ Correct!</p>
          <p class="pts">+{{ s.last_points }}</p>
        } @else if (s.last_correct === false) {
          <p class="big">✗ Not this time</p>
          <p>Keep going — the next one is yours.</p>
        } @else {
          <p class="big">Answer in!</p>
          <p>No right answer on this one.</p>
        }
      </div>
      @if (s.rank) {
        <p class="place">
          You are <strong>{{ ordinal(s.rank) }}</strong> of {{ s.players }}
          with <strong>{{ s.score }}</strong> points
        </p>
      }
    } @else {
      <p class="place">Counting the points…</p>
    }
  `,
  styles: [
    `
      .card { border-radius: 12px; padding: 1.6rem 1rem; text-align: center; color: #fff;
              background: #46178f; animation: pop 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) both; }
      .card.right { background: #26890c; }
      .card.wrong, .card.none { background: #e21b3c; }
      .card p { margin: 0.2rem 0; }
      .big { font-size: 2rem; font-weight: 800; }
      .pts { font-size: 1.6rem; font-weight: 800; background: rgba(0, 0, 0, 0.2); display: inline-block;
             padding: 0.2rem 0.9rem; border-radius: 999px; margin-top: 0.4rem !important; }
      .place { text-align: center; font-size: 1.1rem; margin-top: 1rem; }
      @keyframes pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
    `,
  ],
})
export class GameVerdictComponent {
  @Input() standing: Standing | null = null;

  ordinal(n: number): string {
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
    return `${n}${suffix}`;
  }
}
