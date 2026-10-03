import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, PARAM_SPEC_BY_PATH, PARAM_SPECS, type CameraShot } from '../state/params';
import { getPreset } from '../state/presets';
import { getPath } from '../state/store';
import { applyLessonUpTo } from './applyStep';
import { EXTRA_HIGHLIGHTS, GLOSSARY, LESSONS } from './lessons';

const CAMERAS: readonly CameraShot[] = [
  'overview',
  'side',
  'front',
  'top',
  'tip',
  'behind',
  'section',
];
const ALLOWED_TAGS = new Set(['p', 'strong', 'em', 'ul', 'ol', 'li', 'br']);
const VOID_TAGS = new Set(['br']);

/** Minimal well-formedness check for the small HTML subset lesson bodies may use. */
function checkHtml(html: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) problems.push(`disallowed tag <${tag}>`);
    if (!closing && m[3]!.trim() !== '' && m[3]!.trim() !== '/')
      problems.push(`attributes on <${tag}>`);
    if (VOID_TAGS.has(tag)) continue;
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) problems.push(`unbalanced </${tag}>`);
  }
  if (stack.length) problems.push(`unclosed <${stack.join('>, <')}>`);
  return problems;
}

describe('LESSONS data', () => {
  it('has 7 or 8 lessons with unique ids and 3 to 6 steps each (8 for the first)', () => {
    expect(LESSONS.length).toBeGreaterThanOrEqual(7);
    expect(LESSONS.length).toBeLessThanOrEqual(8);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
    for (const l of LESSONS) {
      expect(l.title.length, l.id).toBeGreaterThan(3);
      expect(l.summary.length, l.id).toBeGreaterThan(20);
      expect(l.minutes, l.id).toBeGreaterThanOrEqual(3);
      expect(l.minutes, l.id).toBeLessThanOrEqual(15);
      expect(l.steps.length, l.id).toBeGreaterThanOrEqual(3);
      // "What is lift?" also tours the probe, the pressure terrain and the air's view.
      expect(l.steps.length, l.id).toBeLessThanOrEqual(l.id === 'what-is-lift' ? 8 : 6);
    }
  });

  it('covers the planned topics', () => {
    const ids = LESSONS.map((l) => l.id);
    for (const id of [
      'what-is-lift',
      'angle-and-stall',
      'speed-and-density',
      'tip-vortices',
      'winglets',
      'sweep',
      'b747-vs-b737',
      'flaps-and-slats',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('every step has an id, a title and a well-formed body; step ids are unique', () => {
    const seen = new Set<string>();
    for (const l of LESSONS) {
      for (const s of l.steps) {
        expect(s.id.startsWith(l.id), s.id).toBe(true);
        expect(seen.has(s.id), `duplicate step id ${s.id}`).toBe(false);
        seen.add(s.id);
        expect(s.title.trim().length, s.id).toBeGreaterThan(3);
        expect(s.body.trim().length, s.id).toBeGreaterThan(80);
        expect(checkHtml(s.body), s.id).toEqual([]);
        if (s.tryIt !== undefined) {
          expect(s.tryIt.trim().length, s.id).toBeGreaterThan(10);
          expect(s.tryIt, s.id).not.toMatch(/[<>]/);
        }
      }
    }
  });

  it('every step with a camera uses a real camera shot, and most steps set one', () => {
    let withCamera = 0;
    let total = 0;
    for (const l of LESSONS) {
      for (const s of l.steps) {
        total++;
        if (s.camera) {
          withCamera++;
          expect(CAMERAS, s.id).toContain(s.camera);
        }
      }
    }
    expect(withCamera / total).toBeGreaterThan(0.9);
  });

  it('every referenced preset exists', () => {
    for (const l of LESSONS) {
      for (const s of l.steps) {
        const a = s.apply;
        if (a?.preset) expect(getPreset(a.preset), `${s.id} preset ${a.preset}`).toBeDefined();
        for (const id of a?.compare ?? []) {
          expect(getPreset(id), `${s.id} compare ${id}`).toBeDefined();
        }
      }
    }
  });

  it('every highlighted control path exists in PARAM_SPECS', () => {
    let highlights = 0;
    for (const l of LESSONS) {
      for (const s of l.steps) {
        for (const path of s.highlight ?? []) {
          highlights++;
          expect(
            PARAM_SPEC_BY_PATH.has(path) || EXTRA_HIGHLIGHTS.includes(path),
            `${s.id} highlights unknown "${path}"`,
          ).toBe(true);
        }
      }
    }
    expect(highlights).toBeGreaterThan(10);
  });

  it('most steps invite the reader to try something', () => {
    const steps = LESSONS.flatMap((l) => l.steps);
    expect(steps.filter((s) => s.tryIt).length / steps.length).toBeGreaterThan(0.9);
  });

  it('each lesson starts from a clean, explicit tunnel set-up', () => {
    for (const l of LESSONS) {
      const first = l.steps[0]!;
      expect(first.apply?.preset, `${l.id} first step loads a preset`).toBeTruthy();
      expect(first.apply?.compare, `${l.id} first step sets compare`).not.toBeUndefined();
      expect(first.apply?.view?.paused, `${l.id} first step unpauses`).toBe(false);
      expect(first.camera, `${l.id} first step sets a camera`).toBeDefined();
    }
  });

  it('what-is-lift opens streamlines from the side for the smoke-pulse myth-buster', () => {
    const lesson = LESSONS.find((l) => l.id === 'what-is-lift')!;
    const myth = lesson.steps.find((s) => /myth/i.test(s.title))!;
    expect(myth).toBeDefined();
    expect(myth.apply?.view?.flowMode).toBe('streamlines');
    expect(myth.camera).toBe('side');
    expect(myth.body).toMatch(/first/i);
  });

  it('the aerodynamics lessons use the camera shots and rake the brief calls for', () => {
    const vortex = LESSONS.find((l) => l.id === 'tip-vortices')!;
    expect(vortex.steps[0]!.apply?.view?.rake?.mode).toBe('tip-vortex');
    expect(vortex.steps.map((s) => s.camera)).toEqual(expect.arrayContaining(['behind', 'tip']));
    const winglets = LESSONS.find((l) => l.id === 'winglets')!;
    const presets = winglets.steps.map((s) => s.apply?.preset);
    expect(presets).toEqual(
      expect.arrayContaining(['b747-400', 'b747-8', 'b737-800', 'b737-max8', 'a380-800']),
    );
    const vs = LESSONS.find((l) => l.id === 'b747-vs-b737')!;
    expect(vs.steps[0]!.apply?.compare).toEqual(['b747-400', 'b737-800']);
  });

  it('replaying any lesson keeps every control inside its allowed range', () => {
    for (const l of LESSONS) {
      for (let i = 0; i < l.steps.length; i++) {
        const state = applyLessonUpTo(DEFAULT_STATE, l.steps, i);
        for (const spec of PARAM_SPECS) {
          const v = getPath(state, spec.path) as number;
          const where = `${l.id}[${i}] ${spec.path}=${v}`;
          expect(v, where).toBeGreaterThanOrEqual(spec.min);
          expect(v, where).toBeLessThanOrEqual(spec.max);
        }
        expect(state.view.rake.count, l.id).toBeGreaterThanOrEqual(8);
        expect(state.view.rake.count, l.id).toBeLessThanOrEqual(64);
        expect(state.view.playbackSpeed, l.id).toBeGreaterThanOrEqual(0.05);
        expect(state.view.playbackSpeed, l.id).toBeLessThanOrEqual(2);
        expect(state.view.sectionEta, l.id).toBeGreaterThanOrEqual(0);
        expect(state.view.sectionEta, l.id).toBeLessThanOrEqual(1);
        expect(CAMERAS, l.id).toContain(state.view.camera);
        if (state.compare) {
          for (const id of state.compare) expect(getPreset(id), `${l.id} ${id}`).toBeDefined();
        }
      }
    }
  });

  it('no step leaves the tunnel paused or the playback at a crawl by accident', () => {
    for (const l of LESSONS) {
      const last = applyLessonUpTo(DEFAULT_STATE, l.steps, l.steps.length - 1);
      expect(last.view.paused, l.id).toBe(false);
      expect(
        last.view.playbackSpeed,
        `${l.id} ends at a normal playback speed`,
      ).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('writes plain text: no emoji or placeholder text', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const l of LESSONS) {
      const text = [
        l.title,
        l.summary,
        ...l.steps.flatMap((s) => [s.title, s.body, s.tryIt ?? '']),
      ];
      for (const t of text) {
        expect(emoji.test(t), `${l.id}: ${t.slice(0, 40)}`).toBe(false);
        expect(/TODO|lorem|xxx/i.test(t), `${l.id}: ${t.slice(0, 40)}`).toBe(false);
      }
    }
  });
});

describe('GLOSSARY', () => {
  it('has 18 to 25 unique, concise entries', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(18);
    expect(GLOSSARY.length).toBeLessThanOrEqual(25);
    const terms = GLOSSARY.map((g) => g.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
    for (const g of GLOSSARY) {
      expect(g.term.trim().length, g.term).toBeGreaterThan(2);
      expect(g.definition.trim().length, g.term).toBeGreaterThan(30);
      expect(g.definition.length, g.term).toBeLessThan(260);
    }
  });

  it('defines the technical words the lessons lean on', () => {
    const terms = new Set(GLOSSARY.map((g) => g.term.toLowerCase()));
    for (const t of [
      'lift',
      'drag',
      'angle of attack',
      'stall',
      'induced drag',
      'wingtip vortex',
      'aspect ratio',
      'mach number',
      'washout',
      'flap',
      'slat',
      'downwash',
    ]) {
      expect(terms.has(t), t).toBe(true);
    }
  });
});
