import { Component, EventEmitter, Input, OnDestroy, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ApiService } from '../api.service';
import {
  CHOICE_KINDS,
  QUESTION_KINDS,
  QUESTION_MODES,
  QuestionKind,
  QuestionMode,
  QuestionSettings,
} from '../models';

export interface ChoiceDraft {
  /** Present when this choice already exists; absent means a new one. */
  id?: number;
  text: string;
  is_correct: boolean;
}

export interface QuestionDraft {
  text: string;
  choices: ChoiceDraft[];
  mode: QuestionMode;
  kind: QuestionKind;
  settings: QuestionSettings;
  /** The figure students tap, for a `point` question. */
  image_url: string | null;
  /**
   * Ticked deliberately for a choice question with no right answer (a poll).
   * Without it a question with nothing marked cannot be saved, so forgetting
   * to mark the answer never silently turns a quiz question into a poll.
   */
  no_answer?: boolean;
}

/** Which settings each kind uses; the others are dropped when saving. */
const SETTINGS_FOR: Record<QuestionKind, (keyof QuestionSettings)[]> = {
  choice: [],
  multi: [],
  rank: [],
  number: ['min', 'max', 'unit', 'answer', 'tolerance'],
  scale: ['min', 'max', 'min_label', 'max_label'],
  word: ['max_words'],
  text: ['max_length'],
  point: [],
};

/** The choices to save: filled ones, for the kinds that have choices. */
export function questionChoices(d: QuestionDraft): ChoiceDraft[] {
  if (!CHOICE_KINDS.includes(d.kind)) return [];
  return d.choices
    .filter((c) => c.text.trim())
    .map((c) => ({ ...c, is_correct: d.kind === 'rank' ? false : c.is_correct }));
}

/** The settings to save: only those the kind uses, and only filled ones. */
export function questionSettings(d: QuestionDraft): QuestionSettings {
  const out: QuestionSettings = {};
  for (const key of SETTINGS_FOR[d.kind]) {
    const v = d.settings[key];
    if (v !== undefined && v !== null && `${v}`.trim() !== '') {
      (out as Record<string, unknown>)[key] = typeof v === 'string' ? v.trim() : v;
    }
  }
  return out;
}

/**
 * The authoring form, used both to add a question and to edit one.
 *
 * Shared rather than duplicated so the two cannot drift: an edit form without
 * the Markdown preview or the image upload would quietly be a worse tool than
 * the one used to write the question in the first place.
 */
@Component({
  selector: 'app-question-editor',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="add-q">
      <label class="mode">
        Kind of question
        <select [(ngModel)]="draft.kind" name="qkind">
          @for (k of kinds; track k.value) {
            <option [value]="k.value">{{ k.label }}</option>
          }
        </select>
      </label>
      <!-- Stable name: only the radio group below needs to differ per editor,
           and this one is what the browser tests address the form by. -->
      <textarea
        [(ngModel)]="draft.text"
        name="qtext"
        (ngModelChange)="onTextChanged()"
        placeholder="Question text — Markdown supported: **bold**, *italic*, lists, tables, images"
      ></textarea>

      <div class="md-tools">
        <label class="upload">
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            (change)="uploadImage($event)"
            hidden
          />
          {{ uploading() ? 'Uploading…' : '🖼 Add image' }}
        </label>
        <span class="md-hint">
          Markdown supported. Uploads are inserted as an image link — add
          <code>&#123;width=60%&#125;</code> after one to size it, as a
          percentage of the column it appears in.
        </span>
      </div>
      @if (uploadError()) {
        <p class="error">{{ uploadError() }}</p>
      }

      @if (draft.text.trim()) {
        <div class="preview">
          <span class="preview-label">Preview</span>
          <div [innerHTML]="preview()"></div>
        </div>
      }

      @if (hasChoices()) {
        @for (c of draft.choices; track $index) {
          <div class="choice-row">
            @if (draft.kind !== 'rank') {
              <label class="mark" [class.on]="c.is_correct">
                <!-- A radio for one right answer, but clicking the marked one
                     again unmarks it: none marked makes the question a poll. -->
                <input
                  [type]="draft.kind === 'choice' ? 'radio' : 'checkbox'"
                  [name]="draft.kind === 'choice' ? 'correct' + formId : 'correct' + formId + $index"
                  [checked]="c.is_correct"
                  (click)="setCorrect($index, $event)"
                />
                <span>correct</span>
              </label>
            }
            <input [(ngModel)]="c.text" [name]="'c' + formId + $index"
                   [placeholder]="draft.kind === 'rank' ? 'Item to put in order' : 'Choice text'" />
            @if (draft.choices.length > 2) {
              <button type="button" class="drop" (click)="removeChoice($index)" title="Remove choice">
                ✕
              </button>
            }
          </div>
        }
        @if (draft.kind !== 'rank') {
          <label class="poll">
            <input type="checkbox" name="noanswer" [checked]="draft.no_answer" (change)="setNoAnswer()" />
            No right answer (a poll)
          </label>
        }
        <p class="about">
          @switch (draft.kind) {
            @case ('choice') { Mark the correct choice, or tick “No right answer” for a poll. }
            @case ('multi') { Mark every correct choice; an answer is right when it ticks exactly those. }
            @case ('rank') { Students put the items in order; the result is each item's average place. }
          }
        </p>
      }

      @switch (draft.kind) {
        @case ('number') {
          <div class="settings">
            <label>Lowest <input type="number" step="any" [(ngModel)]="draft.settings.min" name="smin" /></label>
            <label>Highest <input type="number" step="any" [(ngModel)]="draft.settings.max" name="smax" /></label>
            <label>Unit <input [(ngModel)]="draft.settings.unit" name="sunit" placeholder="e.g. Å" /></label>
            <label>Right answer <input type="number" step="any" [(ngModel)]="draft.settings.answer" name="sanswer" placeholder="optional" /></label>
            <label>± <input type="number" step="any" min="0" [(ngModel)]="draft.settings.tolerance" name="stol" placeholder="0" /></label>
          </div>
          <p class="about">Shown as a histogram. Leave the right answer empty when there is none (an estimate, a guess).</p>
        }
        @case ('scale') {
          <div class="settings">
            <label>From <input type="number" step="1" [(ngModel)]="draft.settings.min" name="smin" placeholder="1" /></label>
            <label>to <input type="number" step="1" [(ngModel)]="draft.settings.max" name="smax" placeholder="5" /></label>
            <label>Label at the low end <input [(ngModel)]="draft.settings.min_label" name="sminl" placeholder="e.g. not at all" /></label>
            <label>Label at the high end <input [(ngModel)]="draft.settings.max_label" name="smaxl" placeholder="e.g. completely" /></label>
          </div>
        }
        @case ('word') {
          <div class="settings">
            <label>Words per student <input type="number" min="1" max="10" [(ngModel)]="draft.settings.max_words" name="swords" placeholder="3" /></label>
          </div>
          <p class="about">Shown as a word cloud: the more students give a word, the bigger it is.</p>
        }
        @case ('text') {
          <div class="settings">
            <label>Longest answer (characters) <input type="number" min="20" max="2000" [(ngModel)]="draft.settings.max_length" name="slen" placeholder="500" /></label>
          </div>
          <p class="about">Shown as anonymous cards. You can hide a card from the projector and the phones.</p>
        }
        @case ('point') {
          <div class="md-tools">
            <label class="upload">
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp"
                     (change)="uploadFigure($event)" hidden />
              {{ uploading() ? 'Uploading…' : draft.image_url ? '🖼 Replace the figure' : '🖼 Upload the figure to tap' }}
            </label>
          </div>
          @if (draft.image_url) { <img class="fig" [src]="draft.image_url" alt="" /> }
          <p class="about">Students tap a place on this figure; the result shows every tap on it.</p>
        }
      }

      <label class="mode">
        How it is run
        <select [(ngModel)]="draft.mode" name="qmode">
          @for (m of modes; track m.value) {
            <option [value]="m.value">{{ m.label }}</option>
          }
        </select>
      </label>

      @if (hasChoices()) {
        <button type="button" (click)="addChoiceRow()">+ choice</button>
      }
      <button (click)="save.emit()" [disabled]="!valid()">{{ submitLabel }}</button>
      @if (showCancel) {
        <button type="button" class="cancel" (click)="cancel.emit()">Cancel</button>
      }

      @if (!valid()) {
        <p class="hint">{{ whyInvalid() }}</p>
      }
      @if (error) {
        <p class="error">{{ error }}</p>
      }
    </div>
  `,
  styles: [
    `
      .mode { display: block; margin: 0.6rem 0; font-size: 0.85rem; color: #555; }
      .mode select { display: block; margin-top: 0.2rem; max-width: 100%; }
      .choice-row { display: flex; gap: 0.5rem; align-items: center; margin: 0.3rem 0; }
      .mark { display: inline-flex; align-items: center; gap: 0.3rem; cursor: pointer;
              border: 1px solid var(--border); border-radius: 6px; padding: 0.25rem 0.5rem;
              font-size: 0.85rem; color: #777; white-space: nowrap; }
      .mark.on { border-color: #2c7a51; background: #eafaf1; color: #2c7a51; font-weight: 600; }
      .choice-row input[type='text'], .choice-row input:not([type]) { flex: 1; }
      .drop { border: none; background: none; cursor: pointer; color: #999; font-size: 0.9rem; }
      .drop:hover { color: #c0392b; }
      .cancel { background: none; }
      .hint, .about { font-size: 0.85rem; color: #777; margin: 0.3rem 0 0; }
      textarea { width: 100%; min-height: 5rem; font-family: inherit; }
      .md-tools { display: flex; gap: 0.6rem; align-items: center; margin: 0.4rem 0; }
      .upload { cursor: pointer; border: 1px solid var(--border); border-radius: 6px;
                padding: 0.35rem 0.7rem; font-size: 0.85rem; white-space: nowrap; }
      .md-hint { font-size: 0.8rem; color: #777; }
      .preview { border: 1px dashed #ccc; border-radius: 6px; padding: 0.6rem;
                 margin: 0.5rem 0; position: relative; }
      .preview-label { position: absolute; top: -0.6rem; left: 0.6rem; background: #fff;
                       padding: 0 0.3rem; font-size: 0.7rem; color: #888; text-transform: uppercase; }
      .preview table { border-collapse: collapse; }
      .preview th, .preview td { border: 1px solid #ddd; padding: 0.2rem 0.4rem; }
      .error { color: #c0392b; }
      .poll { display: block; font-size: 0.85rem; color: #555; margin: 0.3rem 0; }
      .settings { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin: 0.5rem 0; }
      .settings label { font-size: 0.85rem; color: #555; display: flex; flex-direction: column; }
      .settings input { width: 9rem; }
      .fig { display: block; max-width: 100%; max-height: 16rem; margin: 0.4rem 0; border-radius: 6px; }
    `,
  ],
})
export class QuestionEditorComponent implements OnDestroy {
  @Input({ required: true }) draft!: QuestionDraft;
  readonly modes = QUESTION_MODES;
  readonly kinds = QUESTION_KINDS;
  @Input() submitLabel = 'Save question';
  @Input() showCancel = false;
  @Input() error = '';
  /** Distinguishes radio groups when two editors are on the page at once. */
  @Input() formId = '';

  @Output() save = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  uploading = signal(false);
  uploadError = signal('');
  preview = signal<string>('');
  private previewTimer?: ReturnType<typeof setTimeout>;

  constructor(private api: ApiService) {}

  ngOnDestroy(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
  }

  /** Render on the server, so the teacher sees exactly what students get. */
  refreshPreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      const text = this.draft.text.trim();
      if (!text) {
        this.preview.set('');
        return;
      }
      this.api.renderMarkdown(text).subscribe({
        next: ({ html }) => this.preview.set(html),
        error: () => this.preview.set(''),
      });
    }, 300);
  }

  onTextChanged(): void {
    this.refreshPreview();
  }

  /**
   * Upload a figure and append the Markdown that displays it. Files live on
   * the app's own volume so a question cannot break because an external host
   * is down mid-lecture.
   */
  uploadImage(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploadError.set('');
    this.uploading.set(true);
    this.api.uploadImage(file).subscribe({
      next: ({ markdown }) => {
        const sep = this.draft.text && !this.draft.text.endsWith('\n') ? '\n\n' : '';
        this.draft.text = `${this.draft.text}${sep}${markdown}`;
        this.uploading.set(false);
        input.value = '';
        this.refreshPreview();
      },
      error: (err) => {
        this.uploadError.set(err?.error?.detail ?? 'Could not upload that image.');
        this.uploading.set(false);
        input.value = '';
      },
    });
  }

  hasChoices(): boolean {
    return CHOICE_KINDS.includes(this.draft.kind);
  }

  /** Upload the figure students tap (a `point` question): it is the question's own image. */
  uploadFigure(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploadError.set('');
    this.uploading.set(true);
    this.api.uploadImage(file).subscribe({
      next: ({ url }) => {
        this.draft.image_url = url;
        this.uploading.set(false);
        input.value = '';
      },
      error: (err) => {
        this.uploadError.set(err?.error?.detail ?? 'Could not upload that image.');
        this.uploading.set(false);
        input.value = '';
      },
    });
  }

  addChoiceRow(): void {
    this.draft.choices.push({ text: '', is_correct: false });
  }

  removeChoice(index: number): void {
    this.draft.choices.splice(index, 1);
  }

  /**
   * Mark or unmark a choice. A single-choice question has at most one right
   * choice, so marking one unmarks the rest; marking none makes it a poll.
   */
  setNoAnswer(): void {
    this.draft.no_answer = !this.draft.no_answer;
    if (this.draft.no_answer) this.draft.choices.forEach((c) => (c.is_correct = false));
  }

  setCorrect(index: number, event?: Event): void {
    const on = !this.draft.choices[index].is_correct;
    if (on) this.draft.no_answer = false;
    // The browser has already changed the input; keep it in step with the draft.
    if (event) (event.target as HTMLInputElement).checked = on;
    this.draft.choices.forEach((c, i) => {
      if (i === index) c.is_correct = on;
      else if (this.draft.kind === 'choice' && on) c.is_correct = false;
    });
  }

  /** Why the question cannot be saved yet, in the teacher's terms. */
  whyInvalid(): string {
    const d = this.draft;
    if (!d.text.trim()) return 'Write the question text.';
    const s = questionSettings(d);
    if (this.hasChoices()) {
      const filled = d.choices.filter((c) => c.text.trim());
      if (filled.length < 2) return 'Add at least two choices.';
      const marked = filled.filter((c) => c.is_correct).length;
      if (d.kind === 'choice' && marked > 1)
        return 'Mark at most one choice as correct (or use “Choose all that apply”).';
      if (d.kind !== 'rank' && !marked && !d.no_answer)
        return 'Mark which choice is correct, or tick “No right answer”.';
    }
    if (s.min !== undefined && s.max !== undefined && s.min >= s.max)
      return 'The lowest value must be smaller than the highest.';
    if (d.kind === 'scale') {
      const lo = s.min ?? 1;
      const hi = s.max ?? 5;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi - lo < 1 || hi - lo > 10)
        return 'A scale runs between two whole numbers, at most 10 apart.';
    }
    if (d.kind === 'number' && s.answer !== undefined &&
        ((s.min !== undefined && s.answer < s.min) || (s.max !== undefined && s.answer > s.max)))
      return 'The right answer must lie between the lowest and highest values.';
    if (d.kind === 'point' && !d.image_url) return 'Upload the figure students will tap.';
    return '';
  }

  valid(): boolean {
    return this.whyInvalid() === '';
  }
}
