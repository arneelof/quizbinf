import { Component, Input, OnDestroy, computed, signal } from '@angular/core';

import { Leaderboard, LeaderboardEntry } from '../models';

/** How many players the projected leaderboard shows. */
const BOARD_SIZE = 5;
/** Height of one row, in rem; rows move by multiples of it. */
const ROW_REM = 4.6;
/** How long the scores take to count up, and the rows to change places. */
const COUNT_MS = 1400;
/** How long the rows sit at their old places before they start to move. */
const HOLD_MS = 400;

/**
 * A competition's top five, animated from where they stood before the last
 * question to where they stand now: rows slide into their new places while
 * the scores count up, and a player who climbed into the top five rises from
 * below it. Nicknames only.
 */
@Component({
  selector: 'app-game-leaderboard',
  standalone: true,
  template: `
    @if (board(); as b) {
      <div class="board" [style.height.rem]="rows().length * rowRem">
        @for (row of rows(); track row.entry.participant_id) {
          <div class="row" [class.first]="row.index === 0"
               [style.transform]="'translateY(' + (settled() ? row.index : row.from) * rowRem + 'rem)'"
               [style.opacity]="settled() || row.from < size ? 1 : 0">
            <span class="place">{{ row.entry.rank }}</span>
            <span class="nick">{{ row.entry.nickname }}</span>
            @if (row.entry.gained > 0) {
              <span class="gain">+{{ row.entry.gained }}</span>
            }
            @if (settled() && climbed(row.entry); as n) {
              <span class="up">▲ {{ n }}</span>
            }
            <span class="score">{{ shownScore(row.entry) }}</span>
          </div>
        }
      </div>
      @if (!b.entries.length) {
        <p class="empty">Nobody has picked a nickname yet.</p>
      }
    }
  `,
  styles: [
    `
      .board { position: relative; max-width: 46rem; margin: 0 auto; }
      .row { position: absolute; left: 0; right: 0; top: 0; height: 3.9rem; display: flex;
             align-items: center; gap: 1rem; padding: 0 1.4rem; background: #fff; color: #222;
             border-radius: 8px; font-size: 1.5rem; font-weight: 800;
             box-shadow: 0 4px 0 rgba(0, 0, 0, 0.2);
             transition: transform 1400ms cubic-bezier(0.5, 0, 0.2, 1), opacity 0.6s; }
      .row.first { background: #ffcc00; color: #3a2500; }
      .place { width: 2rem; text-align: center; color: #46178f; }
      .row.first .place { color: #3a2500; }
      .nick { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .gain { font-size: 1rem; color: #26890c; background: #e5f6e0; padding: 0.1rem 0.5rem;
              border-radius: 999px; animation: pop 0.5s 0.3s both; }
      .up { font-size: 0.95rem; color: #1368ce; animation: pop 0.5s both; }
      .score { min-width: 5rem; text-align: right; font-variant-numeric: tabular-nums; }
      .empty { text-align: center; opacity: 0.7; font-style: italic; }
      @keyframes pop { from { transform: scale(0.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .row, .gain, .up { transition: none; animation: none; }
      }
    `,
  ],
})
export class GameLeaderboardComponent implements OnDestroy {
  readonly board = signal<Leaderboard | null>(null);
  /** False while the rows sit at their old places. */
  readonly settled = signal(false);
  /** 0 → 1 while the scores count up. */
  private readonly progress = signal(0);
  readonly rowRem = ROW_REM;
  readonly size = BOARD_SIZE;
  private started = false;
  private hold?: ReturnType<typeof setTimeout>;
  private frame = 0;

  /** The animation runs once, from the first board this component is given. */
  @Input() set data(b: Leaderboard | null) {
    this.board.set(b);
    if (b && !this.started) {
      this.started = true;
      this.play();
    }
  }

  /**
   * The rows to draw, each with where it stood before the last question
   * (`from`) and where it stands now (`index`). Anyone outside the top five
   * before starts just below it, invisible, and slides up.
   */
  readonly rows = computed(() => {
    const entries = this.board()?.entries ?? [];
    const before = [...entries].sort(
      (a, b) => b.score - b.gained - (a.score - a.gained) || a.nickname.localeCompare(b.nickname),
    );
    return entries.slice(0, BOARD_SIZE).map((entry, index) => ({
      entry,
      index,
      from: Math.min(before.indexOf(entry), BOARD_SIZE),
    }));
  });

  ngOnDestroy(): void {
    clearTimeout(this.hold);
    cancelAnimationFrame(this.frame);
  }

  /** Places gained by the last question, or 0. */
  climbed(e: LeaderboardEntry): number {
    return e.previous_rank !== null && e.previous_rank > e.rank ? e.previous_rank - e.rank : 0;
  }

  /** The score as it counts up from where it was before the last question. */
  shownScore(e: LeaderboardEntry): number {
    const eased = 1 - Math.pow(1 - this.progress(), 3);
    return Math.round(e.score - e.gained + e.gained * eased);
  }

  private play(): void {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.settled.set(true);
      this.progress.set(1);
      return;
    }
    this.hold = setTimeout(() => this.settled.set(true), HOLD_MS);
    const start = performance.now() + HOLD_MS;
    const count = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - start) / COUNT_MS));
      this.progress.set(p);
      if (p < 1) this.frame = requestAnimationFrame(count);
    };
    this.frame = requestAnimationFrame(count);
  }
}
