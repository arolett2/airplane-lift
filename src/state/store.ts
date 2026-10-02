/**
 * Minimal typed observable store. State objects are treated as immutable: every update
 * produces a new top-level object (structural sharing for untouched branches).
 */
export type Listener<T> = (state: T, prev: T) => void;
export type Updater<T> = Partial<T> | ((state: T) => T);

export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  set(update: Updater<T>): void {
    const prev = this.state;
    const next = typeof update === 'function' ? update(prev) : { ...prev, ...update };
    if (next === prev) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener(next, prev);
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to a derived slice; the listener fires only when the slice changes
   * (by `equals`, default Object.is). Calls the listener immediately when `fireNow` is true.
   */
  select<U>(
    selector: (state: T) => U,
    listener: (slice: U, prevSlice: U) => void,
    options: { equals?: (a: U, b: U) => boolean; fireNow?: boolean } = {},
  ): () => void {
    const equals = options.equals ?? Object.is;
    let current = selector(this.state);
    if (options.fireNow) listener(current, current);
    return this.subscribe((state) => {
      const next = selector(state);
      if (equals(next, current)) return;
      const prevSlice = current;
      current = next;
      listener(next, prevSlice);
    });
  }
}

/** Read a dotted path ("wing.tipDevice.size") from a plain object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Immutably set a dotted path, copying every object along the way. */
export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const write = (node: unknown, i: number): unknown => {
    const key = keys[i]!;
    const base = node !== null && typeof node === 'object' ? (node as Record<string, unknown>) : {};
    const child = i === keys.length - 1 ? value : write(base[key], i + 1);
    if (base[key] === child) return node;
    return Array.isArray(base)
      ? Object.assign([...base], { [key]: child })
      : { ...base, [key]: child };
  };
  return write(obj, 0) as T;
}

/** Structural equality for plain JSON-like data (numbers, strings, booleans, arrays, objects). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/** Deep-merge a partial patch into a plain object (arrays are replaced, not merged). */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] =
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      cur !== null &&
      typeof cur === 'object'
        ? deepMerge(cur, v as DeepPartial<typeof cur>)
        : v;
  }
  return out as T;
}
