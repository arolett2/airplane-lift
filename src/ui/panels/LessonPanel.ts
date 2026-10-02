/**
 * Guided-lesson UI: a lesson picker (cards) and a step card (title, body, "Try it" callout,
 * back/next, step dots). OWNER: content agent.
 *
 * Behaviour:
 *  - `open()` shows the picker. Picking a lesson remembers the state the tunnel was in, then
 *    shows step 1.
 *  - Opening a step REPLAYS the lesson from that remembered state up to the step
 *    (`applyLessonUpTo`), so each step looks the same whichever way the person got there. View
 *    preferences that lessons never touch (units, engineer mode, particle density) are kept.
 *  - `step.highlight` adds `is-highlighted` to every `[data-param="<path>"]` element.
 *  - Left/right arrow keys move between steps (ignored while typing or dragging a slider).
 *  - Completed lessons are remembered in localStorage (every access is wrapped in try/catch).
 */
import '../styles/lesson.css';
import type { AppState } from '../../state/params';
import type { Store } from '../../state/store';
import { applyLessonUpTo } from '../../content/applyStep';
import { GLOSSARY, LESSONS } from '../../content/lessons';
import type { Lesson } from '../../content/types';

export const LESSON_STORAGE_KEY = 'airplane-lift:lessons:v1';
export const HIGHLIGHT_CLASS = 'is-highlighted';

type Mode = 'closed' | 'picker' | 'step';

/** Create an element with an optional class and text (text is never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, ariaLabel?: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  return b;
}

/** True when the key press belongs to a text field, select, slider or similar control. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  const role = target.getAttribute('role');
  return role === 'slider' || role === 'textbox' || role === 'spinbutton' || role === 'listbox';
}

function loadCompleted(): Set<string> {
  try {
    const raw = localStorage.getItem(LESSON_STORAGE_KEY);
    if (!raw) return new Set();
    const data: unknown = JSON.parse(raw);
    const list = (data as { completed?: unknown } | null)?.completed;
    if (!Array.isArray(list)) return new Set();
    return new Set(list.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function saveCompleted(completed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(LESSON_STORAGE_KEY, JSON.stringify({ completed: [...completed] }));
  } catch {
    // Storage may be unavailable (private mode, blocked, quota). Progress is a convenience.
  }
}

export class LessonPanel {
  private readonly store: Store<AppState>;
  private readonly container: HTMLElement;

  /* Picker */
  private readonly picker: HTMLElement;
  private readonly cardList: HTMLElement;

  /* Step card */
  private readonly stepView: HTMLElement;
  private readonly kicker: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tryIt: HTMLElement;
  private readonly tryItText: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly prevButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly live: HTMLElement;

  private mode: Mode = 'closed';
  private lesson: Lesson | null = null;
  private stepIndex = 0;
  /** State of the tunnel when the lesson began; every step is replayed from here. */
  private base: AppState | null = null;
  private completed: Set<string>;
  private syncing = false;

  private highlightPaths: readonly string[] = [];
  private readonly highlighted = new Set<Element>();

  private readonly unsubscribe: Array<() => void> = [];

  constructor(root: HTMLElement, store: Store<AppState>) {
    this.store = store;
    this.completed = loadCompleted();

    this.container = el('section', 'lesson-panel');
    this.container.setAttribute('aria-label', 'Guided lessons');
    this.container.hidden = true;

    /* ---- picker ---- */
    this.picker = el('div', 'lesson-picker');
    const pickerHead = el('header', 'lesson-head');
    pickerHead.append(el('h2', 'lesson-heading', 'Guided lessons'));
    const pickerClose = button('lesson-close', '×', 'Close lessons');
    pickerClose.addEventListener('click', () => this.close());
    pickerHead.append(pickerClose);
    this.cardList = el('ul', 'lesson-cards');
    const glossary = el('details', 'lesson-glossary');
    glossary.append(el('summary', undefined, 'Glossary'));
    const terms = el('dl', 'lesson-terms');
    for (const entry of [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term))) {
      terms.append(el('dt', undefined, entry.term), el('dd', undefined, entry.definition));
    }
    glossary.append(terms);
    this.picker.append(
      pickerHead,
      el(
        'p',
        'lesson-intro',
        'Pick a topic. Each lesson sets up the wind tunnel for you, then lets you play with the controls.',
      ),
      this.cardList,
      glossary,
    );

    /* ---- step card ---- */
    this.stepView = el('div', 'lesson-step');
    const stepHead = el('header', 'lesson-head');
    const menu = button('lesson-menu', '← All lessons');
    menu.addEventListener('click', () => this.showPicker());
    this.kicker = el('p', 'lesson-kicker');
    const stepClose = button('lesson-close', '×', 'Close lesson');
    stepClose.addEventListener('click', () => this.close());
    stepHead.append(menu, this.kicker, stepClose);

    this.title = el('h2', 'lesson-title');
    this.title.tabIndex = -1;
    this.body = el('div', 'lesson-body');
    this.tryItText = el('span', 'lesson-tryit-text');
    this.tryIt = el('div', 'lesson-tryit');
    this.tryIt.append(el('strong', 'lesson-tryit-label', 'Try it'), this.tryItText);

    const nav = el('footer', 'lesson-nav');
    this.prevButton = button('lesson-prev', 'Back');
    this.prevButton.addEventListener('click', () => this.goTo(this.stepIndex - 1));
    this.nextButton = button('lesson-next', 'Next');
    this.nextButton.addEventListener('click', () => this.next());
    this.dots = el('ol', 'lesson-dots');
    const reset = button('lesson-reset', 'Reset step');
    reset.title = 'Put the wind tunnel back the way this step set it up';
    reset.addEventListener('click', () => this.goTo(this.stepIndex));
    nav.append(this.prevButton, this.dots, reset, this.nextButton);

    this.live = el('p', 'lesson-sr-only');
    this.live.setAttribute('aria-live', 'polite');
    this.stepView.append(stepHead, this.title, this.body, this.tryIt, nav, this.live);

    this.container.append(this.picker, this.stepView);
    root.append(this.container);

    document.addEventListener('keydown', this.onKeyDown);
    this.unsubscribe.push(
      // Another part of the app changed the lesson progress: follow it.
      store.select(
        (s) => s.lesson,
        (progress) => this.onExternalProgress(progress),
      ),
      // Controls may be re-rendered while a step is open: keep the highlight on live elements.
      store.subscribe(() => this.refreshHighlights()),
    );

    // Resume a lesson that was already in progress in the restored state.
    const initial = store.get().lesson;
    const resume = LESSONS.find((l) => l.id === initial.lessonId);
    if (resume) this.enterStep(resume, initial.step, false);
  }

  /** Show the lesson picker. */
  open(): void {
    this.showPicker();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    for (const off of this.unsubscribe.splice(0)) off();
    this.clearHighlights();
    this.container.remove();
    this.mode = 'closed';
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Picker                                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  private showPicker(): void {
    this.clearHighlights();
    this.highlightPaths = [];
    this.mode = 'picker';
    this.lesson = null;
    this.base = null;
    this.renderCards();
    this.container.hidden = false;
    this.picker.hidden = false;
    this.stepView.hidden = true;
    this.publishProgress(null, 0);
    // Move focus to the first card so keyboard users land inside the panel.
    this.cardList.querySelector<HTMLElement>('button')?.focus();
  }

  private renderCards(): void {
    this.cardList.replaceChildren();
    for (const lesson of LESSONS) {
      const item = el('li');
      const card = button('lesson-card', '');
      card.dataset.lessonId = lesson.id;
      const done = this.completed.has(lesson.id);
      card.append(el('span', 'lesson-card-title', lesson.title));
      card.append(el('span', 'lesson-card-summary', lesson.summary));
      const meta = el('span', 'lesson-card-meta');
      meta.append(el('span', 'lesson-card-minutes', `${lesson.minutes} min`));
      meta.append(el('span', 'lesson-card-steps', `${lesson.steps.length} steps`));
      if (done) {
        const tick = el('span', 'lesson-tick', '✓');
        tick.title = 'Completed';
        tick.setAttribute('role', 'img');
        tick.setAttribute('aria-label', 'Completed');
        meta.append(tick);
        card.classList.add('is-complete');
      }
      card.append(meta);
      card.addEventListener('click', () => this.startLesson(lesson.id));
      item.append(card);
      this.cardList.append(item);
    }
  }

  private startLesson(id: string): void {
    const lesson = LESSONS.find((l) => l.id === id);
    if (!lesson) return;
    this.lesson = lesson;
    this.base = this.store.get();
    this.enterStep(lesson, 0, true);
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Steps                                                                                       */
  /* ------------------------------------------------------------------------------------------ */

  private next(): void {
    if (!this.lesson) return;
    if (this.stepIndex >= this.lesson.steps.length - 1) {
      // Finish: the lesson is already marked complete; go back to the picker for the next one.
      this.showPicker();
    } else {
      this.goTo(this.stepIndex + 1);
    }
  }

  private goTo(index: number): void {
    if (!this.lesson) return;
    this.enterStep(this.lesson, index, true);
  }

  /**
   * Show step `index` of `lesson`. With `apply`, the tunnel is set up for the step (replaying the
   * lesson from the state it started in); without it only the card changes (used to resume).
   */
  private enterStep(lesson: Lesson, index: number, apply: boolean): void {
    const i = Math.max(0, Math.min(index, lesson.steps.length - 1));
    const step = lesson.steps[i]!;
    const lessonChanged = this.lesson?.id !== lesson.id || this.mode !== 'step';
    this.lesson = lesson;
    this.stepIndex = i;
    if (!this.base) this.base = this.store.get();

    if (apply) {
      const base = this.base;
      this.syncing = true;
      try {
        this.store.set((current) => {
          const replayed = applyLessonUpTo(base, lesson.steps, i);
          return {
            ...replayed,
            // Keep the viewer's own display preferences, which no lesson sets.
            view: {
              ...replayed.view,
              units: current.view.units,
              engineerMode: current.view.engineerMode,
              particleDensity: current.view.particleDensity,
            },
            lesson: { lessonId: lesson.id, step: i },
          };
        });
      } finally {
        this.syncing = false;
      }
    }

    this.mode = 'step';
    this.container.hidden = false;
    this.picker.hidden = true;
    this.stepView.hidden = false;
    this.renderStep(lesson, i);
    this.setHighlights(step.highlight ?? [], true);
    if (i === lesson.steps.length - 1) this.markCompleted(lesson.id);
    if (lessonChanged) this.title.focus({ preventScroll: true });
  }

  private renderStep(lesson: Lesson, i: number): void {
    const step = lesson.steps[i]!;
    const total = lesson.steps.length;
    this.kicker.textContent = `${lesson.title} · Step ${i + 1} of ${total}`;
    this.title.textContent = step.title;
    // Lesson bodies are trusted, authored HTML from src/content/lessons.ts.
    this.body.innerHTML = step.body;
    this.tryIt.hidden = !step.tryIt;
    this.tryItText.textContent = step.tryIt ?? '';

    this.prevButton.disabled = i === 0;
    this.nextButton.textContent = i === total - 1 ? 'Finish' : 'Next';

    if (this.dots.dataset.lessonId !== lesson.id) {
      this.dots.dataset.lessonId = lesson.id;
      this.dots.replaceChildren();
      lesson.steps.forEach((s, n) => {
        const item = el('li');
        const dot = button('lesson-dot', '', `Step ${n + 1}: ${s.title}`);
        dot.dataset.step = String(n);
        dot.addEventListener('click', () => this.goTo(n));
        item.append(dot);
        this.dots.append(item);
      });
    }
    this.dots.querySelectorAll<HTMLElement>('.lesson-dot').forEach((dot, n) => {
      dot.classList.toggle('is-current', n === i);
      dot.classList.toggle('is-visited', n < i);
      if (n === i) dot.setAttribute('aria-current', 'step');
      else dot.removeAttribute('aria-current');
    });

    this.live.textContent = `Step ${i + 1} of ${total}: ${step.title}`;
  }

  /** Close the lesson and the panel, leaving the tunnel as the last step set it. */
  private close(): void {
    this.clearHighlights();
    this.highlightPaths = [];
    this.mode = 'closed';
    this.lesson = null;
    this.base = null;
    this.container.hidden = true;
    this.publishProgress(null, 0);
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Progress                                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  /** Write the lesson progress into the app state (skipped when it already matches). */
  private publishProgress(lessonId: string | null, step: number): void {
    const current = this.store.get().lesson;
    if (current.lessonId === lessonId && current.step === step) return;
    this.syncing = true;
    try {
      this.store.set((s) => ({ ...s, lesson: { lessonId, step } }));
    } finally {
      this.syncing = false;
    }
  }

  private onExternalProgress(progress: AppState['lesson']): void {
    if (this.syncing) return;
    if (progress.lessonId === null) {
      if (this.mode === 'step') this.close();
      return;
    }
    const lesson = LESSONS.find((l) => l.id === progress.lessonId);
    if (!lesson) return;
    if (this.mode === 'step' && this.lesson?.id === lesson.id && this.stepIndex === progress.step) {
      return;
    }
    this.enterStep(lesson, progress.step, false);
  }

  private markCompleted(lessonId: string): void {
    if (this.completed.has(lessonId)) return;
    this.completed.add(lessonId);
    saveCompleted(this.completed);
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Highlighting controls                                                                       */
  /* ------------------------------------------------------------------------------------------ */

  private setHighlights(paths: readonly string[], scroll: boolean): void {
    this.clearHighlights();
    this.highlightPaths = paths.filter((p) => /^[\w.]+$/.test(p));
    for (const path of this.highlightPaths) {
      for (const node of document.querySelectorAll(`[data-param="${path}"]`)) {
        node.classList.add(HIGHLIGHT_CLASS);
        this.highlighted.add(node);
      }
    }
    if (scroll) {
      const first = this.highlighted.values().next().value as HTMLElement | undefined;
      if (first && typeof first.scrollIntoView === 'function') {
        first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  private clearHighlights(): void {
    for (const node of this.highlighted) node.classList.remove(HIGHLIGHT_CLASS);
    this.highlighted.clear();
  }

  /** Re-attach the highlight if the controls were re-rendered or appeared later. */
  private refreshHighlights(): void {
    if (this.highlightPaths.length === 0 || this.mode !== 'step') return;
    let stale = this.highlighted.size === 0;
    for (const node of this.highlighted) {
      if (!node.isConnected) {
        stale = true;
        break;
      }
    }
    if (stale) this.setHighlights(this.highlightPaths, false);
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Keyboard                                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.mode === 'closed' || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    if (event.key === 'Escape') {
      // Only when focus is inside the panel, so we never swallow Escape meant for a dialog.
      if (this.container.contains(document.activeElement)) {
        event.preventDefault();
        this.close();
      }
      return;
    }

    if (this.mode !== 'step' || isTextEntry(event.target)) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (this.lesson && this.stepIndex < this.lesson.steps.length - 1)
        this.goTo(this.stepIndex + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (this.stepIndex > 0) this.goTo(this.stepIndex - 1);
    }
  };
}
