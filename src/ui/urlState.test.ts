import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, PARAM_SPEC_BY_PATH, TIP_DEVICE_DEFAULTS } from '../state/params';
import type { AppState } from '../state/params';
import { PRESETS } from '../state/presets';
import { getPath, setPath } from '../state/store';
import { decodeState, encodeState } from './urlState';

/** A state with every encoded field changed from its default, to catch dropped fields. */
function busyState(): AppState {
  let s: AppState = { ...DEFAULT_STATE, presetId: null };
  const set = (path: string, v: unknown) => {
    s = setPath(s, path, v);
  };
  set('wing.span', 35.8);
  set('wing.rootChord', 6.2);
  set('wing.taperRatio', 0.28);
  set('wing.sweepDeg', 31.5);
  set('wing.dihedralDeg', 5);
  set('wing.rootIncidenceDeg', 1.5);
  set('wing.washoutDeg', 3.2);
  set('wing.yehudi.spanFrac', 0.3);
  set('wing.yehudi.chordFrac', 0.4);
  set('wing.airfoil.camber', 0.025);
  set('wing.airfoil.camberPos', 0.5);
  set('wing.airfoil.thickness', 0.11);
  set('wing.tipDevice', { ...TIP_DEVICE_DEFAULTS['split-winglet'], size: 0.115 });
  set('wing.flaps.deflectionDeg', 15);
  set('wing.flaps.chordFrac', 0.3);
  set('wing.flaps.spanFrac', 0.55);
  set('wing.supercritical', true);
  set('wing.slats', true);
  set('flow.alphaDeg', 3.4);
  set('flow.airspeed', 230);
  set('flow.altitude', 10650);
  set('view.flowMode', 'streamlines');
  set('view.colorBy', 'speed');
  set('view.showSurfacePressure', false);
  set('view.showForces', false);
  set('view.showSpanLoad', true);
  set('view.rake.mode', 'tip-vortex');
  set('view.rake.eta', -0.5);
  set('view.rake.height', 0.1);
  set('view.rake.count', 40);
  set('view.sectionEta', 0.8);
  set('view.units', 'imperial');
  set('view.camera', 'tip');
  set('view.sectionBackdrop', 'terrain');
  set('view.sectionFrame', 'air');
  return s;
}

describe('urlState', () => {
  it('round-trips a fully customised wing', () => {
    const state = busyState();
    const hash = encodeState(state);
    const back = decodeState(hash, DEFAULT_STATE);
    expect(back.wing).toEqual(state.wing);
    expect(back.flow).toEqual(state.flow);
    expect(back.view.rake).toEqual(state.view.rake);
    expect(back.view.flowMode).toBe('streamlines');
    expect(back.view.colorBy).toBe('speed');
    expect(back.view.showSurfacePressure).toBe(false);
    expect(back.view.showForces).toBe(false);
    expect(back.view.showSpanLoad).toBe(true);
    expect(back.view.sectionEta).toBe(0.8);
    expect(back.view.units).toBe('imperial');
    expect(back.view.camera).toBe('tip');
    expect(back.view.sectionBackdrop).toBe('terrain');
    expect(back.view.sectionFrame).toBe('air');
    expect(back.presetId).toBeNull();
  });

  it('reads links made before the cross-section views existed, and never shares the probe', () => {
    const enc = (v: unknown) =>
      btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const good = JSON.parse(atob(encodeState(busyState()).replace(/-/g, '+').replace(/_/g, '/')));
    const { s: _dropped, ...old } = good;
    const back = decodeState(enc(old), DEFAULT_STATE);
    expect(back.view.camera).toBe('tip');
    expect(back.view.sectionBackdrop).toBe('tint');
    expect(back.view.sectionFrame).toBe('wing');
    expect(decodeState(enc({ ...good, s: [9, 0] }), DEFAULT_STATE)).toBe(DEFAULT_STATE);

    const probed = setPath(busyState(), 'view.sectionProbe', { x: 0.3, y: 0.1 });
    expect(decodeState(encodeState(probed), DEFAULT_STATE).view.sectionProbe).toBeNull();
  });

  it('keeps a known preset id and drops an unknown one', () => {
    const known = PRESETS[0]!;
    const withPreset: AppState = { ...DEFAULT_STATE, presetId: known.id };
    expect(decodeState(encodeState(withPreset), DEFAULT_STATE).presetId).toBe(known.id);

    const unknown: AppState = { ...DEFAULT_STATE, presetId: 'no-such-aircraft' };
    expect(decodeState(encodeState(unknown), DEFAULT_STATE).presetId).toBeNull();
  });

  it('is URL-hash safe and compact', () => {
    const hash = encodeState(busyState());
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash.length).toBeLessThan(420);
  });

  it('accepts a leading # and leaves unencoded fields from the fallback', () => {
    const fallback: AppState = {
      ...DEFAULT_STATE,
      view: { ...DEFAULT_STATE.view, paused: true, engineerMode: true, playbackSpeed: 0.5 },
      lesson: { lessonId: 'x', step: 2 },
    };
    const back = decodeState('#' + encodeState(busyState()), fallback);
    expect(back.view.paused).toBe(true);
    expect(back.view.engineerMode).toBe(true);
    expect(back.view.playbackSpeed).toBe(0.5);
    expect(back.lesson).toEqual({ lessonId: 'x', step: 2 });
    expect(back.compare).toBeNull();
  });

  it('returns the fallback object for empty, garbage or truncated input', () => {
    const fb = DEFAULT_STATE;
    const good = encodeState(busyState());
    const inputs = [
      '',
      '#',
      '   ',
      'garbage!!',
      '%%%',
      'AAAA',
      'e30', // "{}"
      good.slice(0, 20),
      good + '$',
      btoa('not json'),
      'x'.repeat(10000),
    ];
    for (const input of inputs) expect(decodeState(input, fb)).toBe(fb);
  });

  it('rejects valid JSON with the wrong shape or types', () => {
    const enc = (v: unknown) =>
      btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const good = JSON.parse(atob(encodeState(busyState()).replace(/-/g, '+').replace(/_/g, '/')));
    const fb = DEFAULT_STATE;
    expect(decodeState(enc([1, 2, 3]), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, v: 99 }), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, w: good.w.slice(1) }), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, w: good.w.map(() => 'x') }), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, t: 99 }), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, t: 1.5 }), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, b: -1 }), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, p: 42 }), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, o: [] }), fb)).toBe(fb);
    expect(decodeState(enc({ ...good, f: [null, 1, 2] }), fb)).toBe(fb);
  });

  it('clamps out-of-range numbers to the ParamSpec limits', () => {
    const enc = (v: unknown) =>
      btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const good = JSON.parse(atob(encodeState(busyState()).replace(/-/g, '+').replace(/_/g, '/')));
    const wild = {
      ...good,
      w: good.w.map((_: number, i: number) => (i % 2 === 0 ? 1e9 : -1e9)),
      f: [1e6, -5, 1e9],
      o: [0, 0, 0, 7, -9, 1000, 5, 0, 0],
    };
    const back = decodeState(enc(wild), DEFAULT_STATE);
    expect(back).not.toBe(DEFAULT_STATE);
    for (const path of [
      'wing.span',
      'wing.taperRatio',
      'wing.sweepDeg',
      'wing.tipDevice.size',
      'flow.alphaDeg',
      'flow.airspeed',
      'flow.altitude',
    ]) {
      const spec = PARAM_SPEC_BY_PATH.get(path)!;
      const v = getPath(back, path) as number;
      expect(v).toBeGreaterThanOrEqual(spec.min);
      expect(v).toBeLessThanOrEqual(spec.max);
    }
    expect(back.flow.alphaDeg).toBe(25);
    expect(back.flow.airspeed).toBe(5);
    expect(back.flow.altitude).toBe(13000);
    expect(back.view.rake.eta).toBe(1);
    expect(back.view.rake.height).toBe(-0.3);
    expect(back.view.rake.count).toBe(64);
    expect(back.view.sectionEta).toBe(1);
  });

  it('does not mutate its inputs', () => {
    const fb = DEFAULT_STATE;
    const snapshot = JSON.stringify(fb);
    decodeState(encodeState(busyState()), fb);
    expect(JSON.stringify(fb)).toBe(snapshot);
  });
});
