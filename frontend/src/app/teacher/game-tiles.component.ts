import { Component, Input } from '@angular/core';

import { Question, gameTile } from '../models';

/**
 * A competition question's choices as coloured tiles, each with its shape.
 *
 * Given `counts` (once the clock has stopped) it adds a bar per choice above
 * the tiles and marks the right answer, fading the others. Without them it
 * marks nothing: while the question is open nothing on the projected screen
 * may say which choice is right or how the room is voting.
 */
@Component({
  selector: 'app-game-tiles',
  standalone: true,
  template: `
    @if (counts) {
      <div class="bars">
        @for (c of question.choices; track c.id; let i = $index) {
          <div class="barcol" [class.dim]="graded() && !c.is_correct">
            <span class="count">{{ countFor(c.id) }}</span>
            <div class="bar" [style.background]="tile(i).color" [style.height.%]="barHeight(c.id)"></div>
            <span class="base" [style.background]="tile(i).color">
              {{ tile(i).shape }} @if (c.is_correct) { <b>✓</b> }
            </span>
          </div>
        }
      </div>
    }
    <div class="tiles" [class.compact]="!!counts">
      @for (c of question.choices; track c.id; let i = $index) {
        <div class="tile" [class.dim]="!!counts && graded() && !c.is_correct"
             [style.background]="tile(i).color">
          <span class="shape">{{ tile(i).shape }}</span>
          <span class="ctext">{{ c.text }}</span>
          @if (counts && c.is_correct) { <span class="tick">✓</span> }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; }
      .tile { display: flex; align-items: center; gap: 1rem; padding: 1.4rem 1.2rem; border-radius: 8px;
              font-size: 1.6rem; font-weight: 700; color: #fff; box-shadow: 0 5px 0 rgba(0, 0, 0, 0.25);
              animation: rise 0.45s ease-out both; transition: opacity 0.4s, filter 0.4s; }
      .tile:nth-child(2) { animation-delay: 0.08s; }
      .tile:nth-child(3) { animation-delay: 0.16s; }
      .tile:nth-child(4) { animation-delay: 0.24s; }
      .shape, .tick { font-size: 2rem; }
      .ctext { flex: 1; }
      .dim { opacity: 0.35; filter: grayscale(0.4); }
      .compact .tile { padding: 0.7rem 1rem; font-size: 1.15rem; }
      .compact .shape { font-size: 1.4rem; }
      .bars { display: flex; justify-content: center; align-items: flex-end; gap: 1.5rem;
              height: 11rem; margin: 0.5rem 0 0.8rem; }
      .barcol { display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
                width: 7rem; height: 100%; transition: opacity 0.4s; }
      .count { font-size: 1.6rem; font-weight: 800; margin-bottom: 0.3rem; }
      .bar { width: 100%; min-height: 4px; border-radius: 6px 6px 0 0; transform-origin: bottom;
             animation: grow 0.9s cubic-bezier(0.2, 0.9, 0.3, 1) both; }
      .base { width: 100%; text-align: center; padding: 0.3rem 0; font-size: 1.3rem;
              border-radius: 0 0 6px 6px; filter: brightness(0.85); }
      @keyframes rise { from { transform: translateY(1.5rem); opacity: 0; } to { transform: none; opacity: 1; } }
      @keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
      @media (prefers-reduced-motion: reduce) {
        .tile, .bar { animation: none; transition: none; }
      }
    `,
  ],
})
export class GameTilesComponent {
  /** The teacher's copy of the question, which knows which choice is right. */
  @Input({ required: true }) question!: Question;
  /** Answers per choice id, once the round is closed; null while it is open. */
  @Input() counts: Record<number, number> | null = null;

  tile(i: number) {
    return gameTile(i);
  }

  /** A poll has no right answer, so nothing is faded. */
  graded(): boolean {
    return this.question.graded !== false && this.question.choices.some((c) => c.is_correct);
  }

  countFor(choiceId: number): number {
    return this.counts?.[choiceId] ?? 0;
  }

  /** A bar's height as a share of the tallest, so a single answer still shows. */
  barHeight(choiceId: number): number {
    const most = Math.max(1, ...Object.values(this.counts ?? {}));
    return (100 * this.countFor(choiceId)) / most;
  }
}
