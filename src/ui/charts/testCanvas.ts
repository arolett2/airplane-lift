/**
 * Test helpers for DOM tests: happy-dom has no canvas, so install a recording 2D context and a
 * ResizeObserver that reports a fixed size as soon as an element is observed.
 */
import { vi } from 'vitest';

export interface FakeCanvas {
  /** Every string passed to fillText / strokeText. */
  texts: string[];
  /** Number of calls per context method. */
  counts: Record<string, number>;
  /** Resets the recorded texts and counts. */
  reset(): void;
  restore(): void;
}

export function installFakeCanvas(): FakeCanvas {
  const rec: FakeCanvas = {
    texts: [],
    counts: {},
    reset() {
      rec.texts.length = 0;
      rec.counts = {};
    },
    restore() {
      spy.mockRestore();
    },
  };
  const makeContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
    const store: Record<string | symbol, unknown> = { canvas };
    return new Proxy(store, {
      get(target, prop) {
        if (prop in target) return target[prop];
        const name = String(prop);
        if (name === 'measureText') return (s: string) => ({ width: s.length * 6 });
        if (name === 'createImageData')
          return (w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          });
        if (name === 'createLinearGradient' || name === 'createRadialGradient')
          return () => ({ addColorStop() {} });
        return (...args: unknown[]) => {
          rec.counts[name] = (rec.counts[name] ?? 0) + 1;
          if ((name === 'fillText' || name === 'strokeText') && typeof args[0] === 'string') {
            rec.texts.push(args[0]);
          }
          return undefined;
        };
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  };
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = makeContext(this);
      contexts.set(this, ctx);
    }
    return ctx as never;
  });
  return rec;
}

/** Make every ResizeObserver report `width` x `height` as soon as it starts observing. */
export function installFixedResizeObserver(width: number, height: number): () => void {
  const original = globalThis.ResizeObserver;
  class FixedObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.cb(
        [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = FixedObserver as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = original;
  };
}

/** Wait for a couple of animation frames (coalesced chart draws). */
export function nextFrames(n = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = (): void => {
      if (--left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
