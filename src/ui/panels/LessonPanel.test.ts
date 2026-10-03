// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOSSARY, LESSONS } from '../../content/lessons';
import { DEFAULT_STATE, type AppState } from '../../state/params';
import { getPreset } from '../../state/presets';
import { Store } from '../../state/store';
import { ComparePanel } from './ComparePanel';
import { ATTENTION_CLASS, HIGHLIGHT_CLASS, LESSON_STORAGE_KEY, LessonPanel } from './LessonPanel';

let root: HTMLElement;
let store: Store<AppState>;
let panel: LessonPanel;

function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}
const cards = () => [...root.querySelectorAll<HTMLButtonElement>('.lesson-card')];
const dots = () => [...root.querySelectorAll<HTMLButtonElement>('.lesson-dot')];
const click = (node: Element) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const key = (k: string, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const title = () => q('.lesson-title').textContent;
const kicker = () => q('.lesson-kicker').textContent;
const lessonById = (id: string) => LESSONS.find((l) => l.id === id)!;

function startLesson(id: string) {
  panel.open();
  click(root.querySelector(`.lesson-card[data-lesson-id="${id}"]`)!);
}

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  store = new Store<AppState>(DEFAULT_STATE);
  panel = new LessonPanel(root, store);
});

afterEach(() => {
  panel.destroy();
  vi.restoreAllMocks();
});

describe('LessonPanel picker', () => {
  it('is hidden until opened, then lists every lesson as a card', () => {
    expect(q('.lesson-panel').hidden).toBe(true);
    panel.open();
    expect(q('.lesson-panel').hidden).toBe(false);
    expect(cards()).toHaveLength(LESSONS.length);
    LESSONS.forEach((lesson, i) => {
      const card = cards()[i]!;
      expect(card.dataset.lessonId).toBe(lesson.id);
      expect(card.querySelector('.lesson-card-title')?.textContent).toBe(lesson.title);
      expect(card.querySelector('.lesson-card-summary')?.textContent).toBe(lesson.summary);
      expect(card.querySelector('.lesson-card-minutes')?.textContent).toBe(`${lesson.minutes} min`);
      expect(card.querySelector('.lesson-tick')).toBeNull();
    });
  });

  it('lists the whole glossary alphabetically', () => {
    panel.open();
    const terms = [...root.querySelectorAll('.lesson-terms dt')].map((n) => n.textContent!);
    expect(terms).toHaveLength(GLOSSARY.length);
    expect(terms).toEqual([...terms].sort((a, b) => a.localeCompare(b)));
  });

  it('closes with the close button and clears lesson progress', () => {
    panel.open();
    click(q('.lesson-picker .lesson-close'));
    expect(q('.lesson-panel').hidden).toBe(true);
    expect(store.get().lesson.lessonId).toBeNull();
  });
});

describe('LessonPanel steps', () => {
  it('starting a lesson shows step 1 and sets up the tunnel', () => {
    startLesson('what-is-lift');
    const lesson = lessonById('what-is-lift');
    const step = lesson.steps[0]!;
    expect(q('.lesson-picker').hidden).toBe(true);
    expect(q('.lesson-step').hidden).toBe(false);
    expect(title()).toBe(step.title);
    expect(kicker()).toContain(`Step 1 of ${lesson.steps.length}`);
    expect(q('.lesson-body').innerHTML).toContain('<strong>pressure</strong>');
    expect(q('.lesson-tryit-text').textContent).toBe(step.tryIt);
    expect(store.get().lesson).toEqual({ lessonId: 'what-is-lift', step: 0 });
    expect(store.get().presetId).toBe('demo-rect');
    expect(store.get().view.camera).toBe('overview');
  });

  it('Next and Back move through the steps and keep progress in the store', () => {
    startLesson('what-is-lift');
    const lesson = lessonById('what-is-lift');
    const prev = q<HTMLButtonElement>('.lesson-prev');
    const next = q<HTMLButtonElement>('.lesson-next');
    expect(prev.disabled).toBe(true);
    expect(next.textContent).toBe('Next');

    click(next);
    expect(title()).toBe(lesson.steps[1]!.title);
    expect(store.get().lesson).toEqual({ lessonId: 'what-is-lift', step: 1 });
    expect(prev.disabled).toBe(false);

    click(next);
    expect(store.get().view.camera).toBe('side'); // step 3 switches to the side view
    expect(store.get().view.camera).toBe('side');

    click(prev);
    expect(title()).toBe(lesson.steps[1]!.title);
    expect(store.get().lesson.step).toBe(1);
    expect(store.get().view.camera).toBe('overview'); // replayed, so step 3's camera is gone
  });

  it('shows one step dot per step, marks the current one, and jumps when clicked', () => {
    startLesson('angle-and-stall');
    const lesson = lessonById('angle-and-stall');
    expect(dots()).toHaveLength(lesson.steps.length);
    expect(dots()[0]!.getAttribute('aria-current')).toBe('step');
    expect(dots()[0]!.getAttribute('aria-label')).toContain(lesson.steps[0]!.title);

    click(dots()[3]!);
    expect(title()).toBe(lesson.steps[3]!.title);
    expect(dots()[3]!.getAttribute('aria-current')).toBe('step');
    expect(dots()[0]!.hasAttribute('aria-current')).toBe(false);
    expect(store.get().lesson.step).toBe(3);
    // Jumping straight to step 4 gives the same tunnel as walking there.
    expect(store.get().flow.alphaDeg).toBe(12);
  });

  it('the last step reads "Finish" and returns to the picker', () => {
    startLesson('b747-vs-b737');
    const lesson = lessonById('b747-vs-b737');
    for (let i = 1; i < lesson.steps.length; i++) click(q('.lesson-next'));
    expect(q('.lesson-next').textContent).toBe('Finish');
    click(q('.lesson-next'));
    expect(q('.lesson-picker').hidden).toBe(false);
    expect(q('.lesson-step').hidden).toBe(true);
    expect(store.get().lesson.lessonId).toBeNull();
    // The finished lesson is ticked.
    const card = root.querySelector('.lesson-card[data-lesson-id="b747-vs-b737"]')!;
    expect(card.querySelector('.lesson-tick')).not.toBeNull();
  });

  it('"All lessons" returns to the picker; Reset restores the step set-up', () => {
    startLesson('flaps-and-slats');
    click(q('.lesson-next')); // flaps 25
    expect(store.get().wing.flaps.deflectionDeg).toBe(25);
    store.set((s) => ({
      ...s,
      wing: { ...s.wing, flaps: { ...s.wing.flaps, deflectionDeg: 40 } },
    }));
    click(q('.lesson-reset'));
    expect(store.get().wing.flaps.deflectionDeg).toBe(25);
    click(q('.lesson-menu'));
    expect(q('.lesson-picker').hidden).toBe(false);
  });

  it('replays from the start state, so going back forgets later changes', () => {
    startLesson('flaps-and-slats');
    click(q('.lesson-next'));
    click(q('.lesson-next')); // flaps 25 + slats
    expect(store.get().wing.slats).toBe(true);
    click(q('.lesson-prev'));
    click(q('.lesson-prev'));
    expect(store.get().wing.slats).toBe(false);
    expect(store.get().wing.flaps.deflectionDeg).toBe(0);
    expect(store.get().presetId).toBe('b737-800');
    expect(store.get().flow).toEqual({ alphaDeg: 7, airspeed: 72, altitude: 0 });
  });

  it("keeps the viewer's own display preferences while the lesson changes the tunnel", () => {
    startLesson('what-is-lift');
    store.set((s) => ({ ...s, view: { ...s.view, units: 'metric', engineerMode: true } }));
    click(q('.lesson-next'));
    expect(store.get().view.units).toBe('metric');
    expect(store.get().view.engineerMode).toBe(true);
  });

  it('opens and closes the comparison as the steps ask', () => {
    startLesson('b747-vs-b737');
    expect(store.get().compare).toEqual(['b747-400', 'b737-800']);
    const lesson = lessonById('b747-vs-b737');
    for (let i = 1; i < lesson.steps.length; i++) click(q('.lesson-next'));
    expect(store.get().compare).toBeNull();
  });

  it('folds the step text away and unfolds it on the next step', () => {
    startLesson('what-is-lift');
    const fold = q<HTMLButtonElement>('.lesson-fold');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    click(fold);
    expect(q('.lesson-panel').classList.contains('is-folded')).toBe(true);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.getAttribute('aria-label')).toMatch(/Show/);
    click(q('.lesson-next'));
    expect(q('.lesson-panel').classList.contains('is-folded')).toBe(false);
  });

  it('publishes its height for other overlays and clears it when closed', () => {
    const shell = document.createElement('div');
    shell.dataset.shell = 'true';
    document.body.append(shell);
    const slot = document.createElement('div');
    shell.append(slot);
    const own = new LessonPanel(slot, store);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: 321.4,
    } as DOMRect);
    own.open();
    expect(shell.style.getPropertyValue('--lesson-card-h')).toBe('322px');
    click(slot.querySelector('.lesson-close')!);
    expect(shell.style.getPropertyValue('--lesson-card-h')).toBe('0px');
    own.destroy();
  });

  it('points at the cross-section card when a step frames the section', () => {
    const card = document.createElement('section');
    card.className = 'card';
    card.dataset.card = 'section';
    document.body.append(card);
    const lesson = LESSONS.find((l) => l.steps.some((st) => st.camera === 'section'))!;
    const index = lesson.steps.findIndex((st) => st.camera === 'section');
    startLesson(lesson.id);
    for (let i = 0; i < index; i++) click(q('.lesson-next'));
    expect(card.classList.contains(ATTENTION_CLASS)).toBe(true);
  });

  it('renders the try-it text as plain text and hides the callout when absent', () => {
    startLesson('what-is-lift');
    expect(q('.lesson-tryit').hidden).toBe(false);
    expect(q('.lesson-tryit-text').querySelector('*')).toBeNull();
  });

  it('closing leaves the tunnel as the step set it and clears the lesson progress', () => {
    startLesson('what-is-lift');
    click(q('.lesson-next'));
    click(q('.lesson-step .lesson-close'));
    expect(q('.lesson-panel').hidden).toBe(true);
    expect(store.get().lesson).toEqual({ lessonId: null, step: 0 });
    expect(store.get().presetId).toBe('demo-rect');
  });

  it('follows lesson progress that changes from outside the panel', () => {
    startLesson('what-is-lift');
    store.set((s) => ({ ...s, lesson: { lessonId: 'sweep', step: 2 } }));
    expect(title()).toBe(lessonById('sweep').steps[2]!.title);
    store.set((s) => ({ ...s, lesson: { lessonId: null, step: 0 } }));
    expect(q('.lesson-panel').hidden).toBe(true);
  });

  it('resumes a lesson that is already in progress in the restored state', () => {
    panel.destroy();
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    const restored = new Store<AppState>({
      ...DEFAULT_STATE,
      lesson: { lessonId: 'tip-vortices', step: 2 },
    });
    panel = new LessonPanel(root, restored);
    expect(q('.lesson-panel').hidden).toBe(false);
    expect(title()).toBe(lessonById('tip-vortices').steps[2]!.title);
    // Resuming does not touch the tunnel.
    expect(restored.get().presetId).toBe(DEFAULT_STATE.presetId);
  });
});

describe('LessonPanel keyboard', () => {
  it('left and right arrows move between steps', () => {
    startLesson('what-is-lift');
    key('ArrowRight');
    expect(store.get().lesson.step).toBe(1);
    key('ArrowRight');
    expect(store.get().lesson.step).toBe(2);
    key('ArrowLeft');
    expect(store.get().lesson.step).toBe(1);
    key('ArrowLeft');
    key('ArrowLeft'); // already at the first step
    expect(store.get().lesson.step).toBe(0);
  });

  it('stops at the last step', () => {
    startLesson('what-is-lift');
    const last = lessonById('what-is-lift').steps.length - 1;
    for (let i = 0; i < last + 3; i++) key('ArrowRight');
    expect(store.get().lesson.step).toBe(last);
  });

  it('ignores arrows typed into inputs and sliders, and key presses with modifiers', () => {
    startLesson('what-is-lift');
    const slider = document.createElement('input');
    slider.type = 'range';
    document.body.append(slider);
    key('ArrowRight', slider);
    expect(store.get().lesson.step).toBe(0);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true }),
    );
    expect(store.get().lesson.step).toBe(0);
  });

  it('does nothing while the picker is showing or the panel is closed', () => {
    key('ArrowRight');
    panel.open();
    key('ArrowRight');
    expect(store.get().lesson.lessonId).toBeNull();
  });

  it('Escape closes the panel when focus is inside it', () => {
    startLesson('what-is-lift');
    q('.lesson-next').focus();
    key('Escape', q('.lesson-next'));
    expect(q('.lesson-panel').hidden).toBe(true);
  });

  it('Escape on a comparison the lesson opened closes only the comparison', () => {
    const compareRoot = document.createElement('div');
    document.body.append(compareRoot);
    const compare = new ComparePanel(compareRoot, store, () => new Promise(() => {}));
    startLesson('b747-vs-b737');
    expect(compare.isOpen()).toBe(true);
    // Focus stays in the modal dialog the step opened.
    expect(compareRoot.contains(document.activeElement)).toBe(true);
    key('Escape', document.activeElement!);
    expect(compare.isOpen()).toBe(false);
    expect(q('.lesson-panel').hidden).toBe(false);
    expect(store.get().lesson.lessonId).toBe('b747-vs-b737');
    // ... and focus comes back to the lesson card rather than dropping to <body>.
    expect(document.activeElement).toBe(q('.lesson-title'));
    compare.destroy();
  });

  it('stops listening after destroy', () => {
    startLesson('what-is-lift');
    panel.destroy();
    key('ArrowRight');
    expect(store.get().lesson.step).toBe(0);
    expect(root.querySelector('.lesson-panel')).toBeNull();
  });
});

describe('LessonPanel highlights', () => {
  function addControl(path: string): HTMLElement {
    const node = document.createElement('div');
    node.dataset.param = path;
    document.body.append(node);
    return node;
  }

  it('highlights the controls named by the step and clears them on the next step', () => {
    const alpha = addControl('flow.alphaDeg');
    const alphaTwin = addControl('flow.alphaDeg'); // e.g. slider + number box
    const speed = addControl('flow.airspeed');
    startLesson('what-is-lift');
    const steps = lessonById('what-is-lift').steps;
    expect(steps[0]!.highlight).toBeUndefined();
    expect(alpha.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    click(q('.lesson-next')); // step 2 highlights flow.alphaDeg
    expect(steps[1]!.highlight).toEqual(['flow.alphaDeg']);
    expect(alpha.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(alphaTwin.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(speed.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    click(q('.lesson-next')); // step 3 highlights nothing
    expect(alpha.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    expect(alphaTwin.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('highlights several controls at once and clears them on close', () => {
    const a = addControl('flow.alphaDeg');
    const s = addControl('flow.airspeed');
    const alt = addControl('flow.altitude');
    startLesson('what-is-lift');
    const last = lessonById('what-is-lift').steps.length - 1;
    click(dots()[last]!);
    for (const node of [a, s, alt]) expect(node.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    click(q('.lesson-step .lesson-close'));
    for (const node of [a, s, alt]) expect(node.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('highlights controls that are rendered after the step opened', () => {
    startLesson('what-is-lift');
    click(q('.lesson-next')); // wants flow.alphaDeg, which does not exist yet
    const late = addControl('flow.alphaDeg');
    expect(late.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    store.set((s) => ({ ...s, flow: { ...s.flow, alphaDeg: 9 } })); // any store change
    expect(late.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
  });

  it('re-attaches the highlight when the controls are re-rendered', () => {
    const first = addControl('flow.alphaDeg');
    startLesson('what-is-lift');
    click(q('.lesson-next'));
    expect(first.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    first.remove();
    const replacement = addControl('flow.alphaDeg');
    store.set((s) => ({ ...s, flow: { ...s.flow, alphaDeg: 9 } }));
    expect(replacement.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
  });

  it('clears highlights when the panel is destroyed', () => {
    const alpha = addControl('flow.alphaDeg');
    startLesson('what-is-lift');
    click(q('.lesson-next'));
    expect(alpha.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    panel.destroy();
    expect(alpha.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });
});

describe('LessonPanel progress persistence', () => {
  function finish(id: string) {
    startLesson(id);
    const n = lessonById(id).steps.length;
    for (let i = 1; i < n; i++) click(q('.lesson-next'));
  }

  it('remembers completed lessons across panel instances', () => {
    finish('sweep');
    const saved = JSON.parse(localStorage.getItem(LESSON_STORAGE_KEY)!) as { completed: string[] };
    expect(saved.completed).toEqual(['sweep']);

    panel.destroy();
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    panel = new LessonPanel(root, new Store<AppState>(DEFAULT_STATE));
    panel.open();
    const ticked = cards().filter((c) => c.querySelector('.lesson-tick'));
    expect(ticked.map((c) => c.dataset.lessonId)).toEqual(['sweep']);
  });

  it('does not mark a lesson complete before its last step', () => {
    startLesson('sweep');
    click(q('.lesson-next'));
    expect(localStorage.getItem(LESSON_STORAGE_KEY)).toBeNull();
  });

  it('survives corrupt stored data', () => {
    localStorage.setItem(LESSON_STORAGE_KEY, '{not json');
    panel.destroy();
    panel = new LessonPanel(root, store);
    panel.open();
    expect(cards()).toHaveLength(LESSONS.length);
    expect(root.querySelector('.lesson-tick')).toBeNull();

    localStorage.setItem(LESSON_STORAGE_KEY, JSON.stringify({ completed: [1, 'sweep', null] }));
    panel.destroy();
    panel = new LessonPanel(root, store);
    panel.open();
    expect(
      cards()
        .filter((c) => c.querySelector('.lesson-tick'))
        .map((c) => c.dataset.lessonId),
    ).toEqual(['sweep']);
  });

  it('works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    panel.destroy();
    expect(() => {
      panel = new LessonPanel(root, store);
      finish('what-is-lift');
    }).not.toThrow();
    // Still works for the session: the lesson reached its last step.
    expect(store.get().lesson.step).toBe(lessonById('what-is-lift').steps.length - 1);
  });
});

describe('LessonPanel and presets', () => {
  it('a lesson that loads a preset puts that aircraft in the tunnel', () => {
    startLesson('winglets');
    expect(store.get().presetId).toBe('b737-800');
    click(q('.lesson-next'));
    expect(store.get().presetId).toBe('b747-400');
    expect(store.get().wing).toEqual(getPreset('b747-400')!.wing);
    expect(store.get().flow).toEqual(getPreset('b747-400')!.cruise);
  });
});
