import { Component, EventEmitter, Input, Output } from '@angular/core';

import { Leaderboard, Question } from '../models';
import { GameLeaderboardComponent } from '../teacher/game-leaderboard.component';
import { GamePodiumComponent } from '../teacher/game-podium.component';
import { GameTilesComponent } from '../teacher/game-tiles.component';

export type DemoStage = 'lobby' | 'question' | 'result' | 'leaderboard' | 'podium';

/**
 * The projected screen of the competition demo. Built from the same tiles,
 * leaderboard and podium as the real Game view, so the demo looks like the
 * thing it demonstrates; only the frame around them is drawn here.
 */
@Component({
  selector: 'app-demo-projector',
  standalone: true,
  imports: [GameLeaderboardComponent, GamePodiumComponent, GameTilesComponent],
  template: `
    <div class="game">
      @switch (stage) {
        @case ('lobby') {
          <h2>Bioinformatics showdown</h2>
          <p class="count"><b>{{ players.length }}</b> players</p>
          <div class="bubbles">
            @for (n of players; track n) {
              <span class="bubble" [class.you]="n === you">{{ n }}</span>
            }
          </div>
          <button class="go" [disabled]="!you" (click)="advance.emit()">
            {{ you ? 'Start ▶' : 'Pick a nickname on the phone first' }}
          </button>
        }
        @case ('question') {
          <p class="top">Question {{ number }} of {{ total }}</p>
          <div class="qcard" [innerHTML]="question!.text_html"></div>
          <div class="mid">
            <span class="clock" [class.hurry]="msLeft <= 5000">{{ seconds() }}</span>
            <span class="answers"><b>{{ answered }}</b> of {{ players.length }} answered</span>
          </div>
          <app-game-tiles [question]="question!" />
        }
        @case ('result') {
          <p class="top">Question {{ number }} of {{ total }}</p>
          <div class="qcard small" [innerHTML]="question!.text_html"></div>
          <app-game-tiles [question]="question!" [counts]="counts" />
          <button class="go" (click)="advance.emit()">Leaderboard ▶</button>
        }
        @case ('leaderboard') {
          <h2>Leaderboard</h2>
          <app-game-leaderboard [data]="board" />
          <button class="go" (click)="advance.emit()">
            {{ number < total ? 'Next question ▶' : '🏆 Final results' }}
          </button>
        }
        @case ('podium') {
          <h2>🏆 Winners 🏆</h2>
          <app-game-podium [data]="board" />
          <button class="go" (click)="again.emit()">Play again ↺</button>
        }
      }
    </div>
  `,
  styles: [
    `
      .game { position: relative; overflow: hidden; zoom: 0.72; min-height: 36rem; padding: 1.4rem 1.8rem;
              border-radius: 12px; color: #fff; font-weight: 600;
              background: radial-gradient(circle at 85% 80%, #ffffff14 0 10rem, transparent 10rem),
                          linear-gradient(135deg, #46178f, #2b0f5c); }
      h2 { text-align: center; font-size: 2.4rem; margin: 0.3rem 0 1rem; }
      .count { text-align: center; font-size: 1.4rem; }
      .count b { font-size: 2.6rem; }
      .bubbles { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; margin: 1rem 0 2rem; }
      .bubble { background: #fff; color: #333; padding: 0.45rem 0.9rem; border-radius: 999px;
                animation: pop 0.4s cubic-bezier(0.2, 1.6, 0.4, 1) both; }
      .bubble.you { background: #ffcc00; color: #3a2500; }
      .go { display: block; margin: 1.2rem 0 0 auto; font-size: 1.3rem; font-weight: 800; padding: 0.7rem 2rem;
            border: none; border-radius: 8px; background: #fff; color: #46178f; cursor: pointer;
            box-shadow: 0 5px 0 #0004; }
      .go:disabled { opacity: 0.6; cursor: default; }
      .top { margin: 0; }
      .qcard { background: #fff; color: #222; border-radius: 10px; padding: 1rem 1.4rem; margin: 0.8rem 0;
               text-align: center; font-size: 1.8rem; font-weight: 700; box-shadow: 0 6px 0 #0003; }
      .qcard.small { font-size: 1.3rem; padding: 0.6rem 1rem; }
      .mid { display: flex; justify-content: space-between; align-items: center; margin: 1rem 0; }
      .clock { display: grid; place-items: center; width: 6.5rem; height: 6.5rem; border-radius: 50%;
               border: 0.6rem solid #ffcc00; font-size: 2.6rem; font-weight: 800; }
      .clock.hurry { border-color: #ff4d6d; }
      .answers { font-size: 1.3rem; }
      .answers b { font-size: 2.4rem; }
      @keyframes pop { from { transform: scale(0.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    `,
  ],
})
export class DemoProjectorComponent {
  @Input() stage: DemoStage = 'lobby';
  @Input() players: string[] = [];
  @Input() you = '';
  @Input() question: Question | null = null;
  @Input() number = 1;
  @Input() total = 1;
  @Input() msLeft = 0;
  @Input() answered = 0;
  @Input() counts: Record<number, number> = {};
  @Input() board: Leaderboard | null = null;
  @Output() advance = new EventEmitter<void>();
  @Output() again = new EventEmitter<void>();

  seconds(): number {
    return Math.ceil(this.msLeft / 1000);
  }
}
