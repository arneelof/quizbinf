import { Component, Input, OnDestroy, OnInit, computed, signal } from '@angular/core';

import { Leaderboard } from '../models';

/** When the confetti starts: once the winner's block has risen. */
const CONFETTI_MS = 3400;
const CONFETTI_COLOURS = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#ffcc00', '#ffffff', '#ff6fb1'];

/**
 * The end of a competition: a podium that rises third place first and the
 * winner last, then confetti, with the next five listed underneath.
 */
@Component({
  selector: 'app-game-podium',
  standalone: true,
  template: `
    <div class="podium">
      @for (p of steps(); track p.place) {
        <div [class]="'step place' + p.place">
          @if (p.entry) {
            <div class="who">
              <span class="medal">{{ medals[p.place - 1] }}</span>
              <span class="nick">{{ p.entry.nickname }}</span>
              <span class="pts">{{ p.entry.score }} pts</span>
            </div>
          }
          <div class="block"><span>{{ p.place }}</span></div>
        </div>
      }
    </div>
    @if (runnersUp().length) {
      <ol class="runners" start="4">
        @for (e of runnersUp(); track e.participant_id) {
          <li><b>{{ e.nickname }}</b> {{ e.score }}</li>
        }
      </ol>
    }
    @if (confetti()) {
      <div class="confetti" aria-hidden="true">
        @for (c of pieces; track $index) {
          <i [style.left.%]="c.left" [style.background]="c.color"
             [style.animation-delay.s]="c.delay" [style.animation-duration.s]="c.duration"
             [style.width.px]="c.size" [style.height.px]="c.size * 0.45"></i>
        }
      </div>
    }
  `,
  styles: [
    `
      .podium { display: flex; justify-content: center; align-items: flex-end; gap: 1rem;
                height: 26rem; margin-top: 1rem; }
      .step { display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
              width: 12rem; height: 100%; }
      .block { width: 100%; border-radius: 8px 8px 0 0; display: grid; place-items: center;
               font-size: 3.5rem; font-weight: 800; color: rgba(255, 255, 255, 0.9);
               transform-origin: bottom; animation: grow 1s cubic-bezier(0.2, 0.9, 0.3, 1) both; }
      .who { display: flex; flex-direction: column; align-items: center; margin-bottom: 0.6rem;
             animation: pop 0.6s cubic-bezier(0.2, 1.6, 0.4, 1) both; }
      .medal { font-size: 3rem; }
      .nick { font-size: 1.6rem; font-weight: 800; max-width: 12rem; text-align: center;
              overflow-wrap: anywhere; }
      .pts { opacity: 0.85; font-weight: 700; }
      .place1 .block { height: 60%; background: linear-gradient(#ffd84d, #e0a800); animation-delay: 2.4s; }
      .place1 .who { animation-delay: 3.2s; }
      .place2 .block { height: 44%; background: linear-gradient(#e2e6ea, #a9b2bc); animation-delay: 1.3s; }
      .place2 .who { animation-delay: 2s; }
      .place3 .block { height: 32%; background: linear-gradient(#f0a868, #b8692c); animation-delay: 0.3s; }
      .place3 .who { animation-delay: 1s; }
      .runners { max-width: 30rem; margin: 1.5rem auto 0; padding-left: 2rem; font-size: 1.2rem;
                 animation: fade 0.6s 3.6s both; }
      .runners b { margin-right: 0.6rem; }
      .confetti { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
      .confetti i { position: absolute; top: -5%; border-radius: 2px; opacity: 0.9;
                    animation: fall linear infinite; }
      @keyframes pop { from { transform: scale(0.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      @keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes fall {
        from { transform: translate3d(0, 0, 0) rotate(0deg); }
        to { transform: translate3d(3rem, 110vh, 0) rotate(720deg); }
      }
      @media (prefers-reduced-motion: reduce) {
        .block, .who, .runners { animation: none; }
        .confetti { display: none; }
      }
    `,
  ],
})
export class GamePodiumComponent implements OnInit, OnDestroy {
  readonly board = signal<Leaderboard | null>(null);
  readonly confetti = signal(false);
  readonly medals = ['🥇', '🥈', '🥉'];
  readonly pieces = Array.from({ length: 140 }, () => ({
    left: Math.random() * 100,
    delay: Math.random() * 4,
    duration: 3 + Math.random() * 3,
    size: 8 + Math.random() * 10,
    color: CONFETTI_COLOURS[Math.floor(Math.random() * CONFETTI_COLOURS.length)],
  }));
  private timer?: ReturnType<typeof setTimeout>;

  @Input() set data(b: Leaderboard | null) {
    this.board.set(b);
  }

  /** Second, first, third: the winner in the middle, as on a real podium. */
  readonly steps = computed(() => {
    const top = this.board()?.entries ?? [];
    return [2, 1, 3].map((place) => ({ place, entry: top[place - 1] ?? null }));
  });

  readonly runnersUp = computed(() => (this.board()?.entries ?? []).slice(3, 8));

  ngOnInit(): void {
    this.timer = setTimeout(() => this.confetti.set(true), CONFETTI_MS);
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }
}
