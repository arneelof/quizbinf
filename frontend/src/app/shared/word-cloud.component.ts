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
/** How many of the most-written words are never turned on their side. */
const LEVEL_WORDS = 3;

/**
 * A word cloud laid out with d3-cloud (https://github.com/jasondavies/d3-cloud):
 * the words are packed in a spiral around the centre, biggest first, sized by
 * how many students wrote them. Positions are only tried inside an ellipse, so
 * the words pile up into an oval cloud instead of filling the rectangle, and
 * about a third of the words after the biggest few are turned on their side.
 * That is decided by rank, not by size: in a small class most words are
 * written more than once, so a size threshold left every word horizontal. Drawn as an SVG
 * that scales with its box, so the same layout serves the projector and a phone.
 *
 * The layout is deterministic (every word starts from the centre, and which
 * words turn depends only on the word and its rank) and is only redone when the words or
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
    this.run(words, 1.3);
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
    // The biggest few stay level, so the cloud's main words read at a glance.
    const turned = new Set(
      [...words].sort((a, b) => b.count - a.count).slice(LEVEL_WORDS).filter((w) => hash(w.word) % 3 === 0).map((w) => w.word),
    );
    // Few words may be big; many words must share the space.
    const top = Math.min(130, 34 + 440 / Math.sqrt(words.length)) * scale;
    const counts = new Map(words.map((w) => [w.word, w.count]));
    const colour = new Map(words.map((w, i) => [w.word, COLOURS[i % COLOURS.length]]));
    const layout = cloud()
      .size([WIDTH, HEIGHT])
      .words(words.map((w) => ({ text: w.word, size: 14 * scale + top * Math.pow(w.count / peak, 0.7) })))
      .padding(2)
      .rotate((d) => (turned.has(d.text ?? '') ? -90 : 0))
      .font(FONT)
      .fontWeight('700')
      .fontSize((d) => d.size ?? 14)
      .random(() => 0.5) // every word starts from the centre, so the ellipse is centred
      .spiral(ellipseSpiral(0.9))
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

/**
 * d3-cloud's Archimedean spiral, cut to an ellipse that fills `fill` of the box: a point
 * outside it is replaced by one far outside the box, which d3-cloud rejects, so words only
 * land inside. The real point is returned once the spiral is past d3-cloud's limit, so the
 * search for a word that does not fit still ends.
 */
function ellipseSpiral(fill: number): (size: [number, number]) => (t: number) => [number, number] {
  return (size) => {
    const e = size[0] / size[1];
    const a = (size[0] / 2) * fill;
    const b = (size[1] / 2) * fill;
    const maxDelta = Math.sqrt(size[0] * size[0] + size[1] * size[1]);
    return (t) => {
      t *= 0.1;
      const x = e * t * Math.cos(t);
      const y = t * Math.sin(t);
      if (Math.min(Math.abs(x), Math.abs(y)) >= maxDelta) return [x, y];
      return (x * x) / (a * a) + (y * y) / (b * b) <= 1 ? [x, y] : [size[0] * 2, 0];
    };
  };
}

/** A small string hash (FNV-1a), so that whether a word is turned depends only on the word. */
function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
