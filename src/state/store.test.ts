import { describe, expect, it, vi } from 'vitest';
import { Store, deepEqual, deepMerge, getPath, setPath } from './store';

describe('Store', () => {
  it('notifies subscribers and selectors only on change', () => {
    const s = new Store({ a: 1, b: { c: 2 } });
    const all = vi.fn();
    const sel = vi.fn();
    s.subscribe(all);
    s.select((st) => st.b, sel);
    s.set({ a: 2 });
    expect(all).toHaveBeenCalledTimes(1);
    expect(sel).not.toHaveBeenCalled();
    s.set((st) => setPath(st, 'b.c', 3));
    expect(sel).toHaveBeenCalledTimes(1);
    expect(s.get().b.c).toBe(3);
  });

  it('path helpers copy only along the path', () => {
    const o = { x: { y: 1 }, z: { w: 2 } };
    const p = setPath(o, 'x.y', 5);
    expect(getPath(p, 'x.y')).toBe(5);
    expect(p.z).toBe(o.z);
    expect(o.x.y).toBe(1);
  });

  it('deepMerge and deepEqual', () => {
    const base = { a: { b: 1, c: 2 }, d: [1, 2] };
    const m = deepMerge(base, { a: { b: 9 } });
    expect(m).toEqual({ a: { b: 9, c: 2 }, d: [1, 2] });
    expect(deepEqual(m, { a: { b: 9, c: 2 }, d: [1, 2] })).toBe(true);
    expect(deepEqual(m, base)).toBe(false);
  });
});
