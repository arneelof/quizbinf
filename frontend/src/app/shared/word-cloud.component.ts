import { Component, Input, OnChanges, OnDestroy, signal } from '@angular/core';
import cloud from 'd3-cloud';

interface Placed {
  text: string;
  count: number;
  size: number;
  x: number;
  y: number;
  rotate: number;
  colour: string;
}

const WIDTH = 800;
const HEIGHT = 420;
const COLOURS = ['#1f6f8b', '#2c7a51', '#b5651d', '#7b3f8c', '#a23b3b', '#3d5a80'];
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * A word cloud laid out with d3-cloud (https://github.com/jasondavies/d3-cloud):
 * the words are packed in a spiral around the centre, biggest first, sized by
 * how many students wrote them. Drawn as an SVG that scales with its box, so
 * the same layout serves the projector and a phone.
 *
 * The layout uses a fixed random seed and is only redone when the words or
 * counts change, so the cloud does not jump about while the results refresh.
 * If some words do not fit, it is redone with all words smaller.
 */
@Component({
  selector: 'app-word-cloud',
  standalone: true,
  template: `
    <svg class="cloud-svg" [attr.viewBox]="viewBox" role="img" [attr.aria-label]="label()">
      <g [attr.transform]="'translate(' + width / 2 + ',' + height / 2 + ')'">
        @for (w of placed(); track w.text) {
          <g [attr.transform]="'translate(' + w.x + ',' + w.y + ') rotate(' + w.rotate + ')'">
            <title>{{ w.text }}: {{ w.count }}</title>
            <text class="word" text-anchor="middle" [attr.font-size]="w.size" [attr.fill]="w.colour"
                  [attr.font-family]="font" font-weight="700">{{ w.text }}</text>
          </g>
        }
      </g>
    </svg>
  `,
  styles: [
    `
      :host { display: block; }
      .cloud-svg { display: block; width: 100%; height: auto; max-height: 60vh; }
    `,
  ],
})
export class WordCloudComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) words: { word: string; count: number }[] = [];

  readonly width = WIDTH;
  readonly height = HEIGHT;
  readonly viewBox = `0 0 ${WIDTH} ${HEIGHT}`;
  readonly font = FONT;
  placed = signal<Placed[]>([]);

  private key = '';
  private layout: { stop(): unknown } | null = null;

  ngOnChanges(): void {
    const words = (this.words ?? []).slice(0, 80);
    const key = words.map((w) => `${w.word}:${w.count}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.run(words, 1);
  }

  ngOnDestroy(): void {
    this.layout?.stop();
  }

  label(): string {
    return this.placed().map((w) => `${w.text} (${w.count})`).join(', ');
  }

  private run(words: { word: string; count: number }[], scale: number): void {
    this.layout?.stop();
    if (!words.length) {
      this.placed.set([]);
      return;
    }
    const peak = Math.max(1, ...words.map((w) => w.count));
    // Few words may be big; many words must share the space.
    const top = Math.min(110, 30 + 400 / Math.sqrt(words.length)) * scale;
    const counts = new Map(words.map((w) => [w.word, w.count]));
    const colour = new Map(words.map((w, i) => [w.word, COLOURS[i % COLOURS.length]]));
    const random = seeded(1);
    const layout = cloud()
      .size([WIDTH, HEIGHT])
      .words(words.map((w) => ({ text: w.word, size: 14 * scale + top * Math.pow(w.count / peak, 0.7) })))
      .padding(4)
      .rotate(() => 0)
      .font(FONT)
      .fontWeight('700')
      .fontSize((d) => d.size ?? 14)
      .random(random)
      .spiral('archimedean')
      .on('end', (out) => {
        if (out.length < words.length && scale > 0.35) {
          this.run(words, scale * 0.85);
          return;
        }
        this.placed.set(
          out.map((d) => ({
            text: d.text ?? '',
            count: counts.get(d.text ?? '') ?? 0,
            size: d.size ?? 14,
            x: d.x ?? 0,
            y: d.y ?? 0,
            rotate: d.rotate ?? 0,
            colour: colour.get(d.text ?? '') ?? COLOURS[0],
          })),
        );
      });
    this.layout = layout;
    layout.start();
  }
}

/** A small seeded generator (mulberry32), so the same words give the same cloud. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
