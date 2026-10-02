// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Disposables, createFrameThrottle, h, svg, uid } from './dom';

afterEach(() => {
  vi.useRealTimers();
});

describe('h / svg', () => {
  it('creates elements with attributes, data, style, handlers and children', () => {
    const onClick = vi.fn();
    const el = h(
      'button',
      {
        class: 'a b',
        type: 'button',
        'aria-pressed': true,
        hidden: false,
        title: null,
        dataset: { paramName: 'x', skip: undefined, n: 3 },
        style: { '--fill': '40%', minWidth: '10px' },
        on: { click: onClick },
      },
      'Go',
      null,
      false,
      7,
    );
    expect(el.className).toBe('a b');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.getAttribute('aria-pressed')).toBe('');
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.dataset.paramName).toBe('x');
    expect(el.hasAttribute('data-skip')).toBe(false);
    expect(el.dataset.n).toBe('3');
    expect(el.style.getPropertyValue('--fill')).toBe('40%');
    expect(el.style.getPropertyValue('min-width')).toBe('10px');
    expect(el.textContent).toBe('Go7');
    el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('creates SVG elements in the SVG namespace', () => {
    const s = svg('svg', { viewBox: '0 0 10 10' }, svg('path', { d: 'M0 0L1 1' }));
    expect(s.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(s.firstElementChild?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(s.getAttribute('viewBox')).toBe('0 0 10 10');
  });

  it('uid returns distinct ids', () => {
    expect(uid('x')).not.toBe(uid('x'));
  });
});

describe('createFrameThrottle', () => {
  it('applies only the latest value once per frame', () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const t = createFrameThrottle<number>(apply);
    t.push(1);
    t.push(2);
    t.push(3);
    expect(t.pending).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(3);
    expect(t.pending).toBe(false);
  });

  it('flush applies immediately and does not apply twice', () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const t = createFrameThrottle<number>(apply);
    t.push(5);
    t.flush();
    expect(apply).toHaveBeenCalledWith(5);
    vi.advanceTimersByTime(50);
    expect(apply).toHaveBeenCalledTimes(1);
    t.flush();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the pending value', () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const t = createFrameThrottle<number>(apply);
    t.push(5);
    t.cancel();
    vi.advanceTimersByTime(50);
    expect(apply).not.toHaveBeenCalled();
    expect(t.pending).toBe(false);
  });
});

describe('Disposables', () => {
  it('removes listeners and runs callbacks in reverse order', () => {
    const d = new Disposables();
    const el = h('div');
    const handler = vi.fn();
    d.listen(el, 'click', handler);
    const order: number[] = [];
    d.add(() => order.push(1));
    d.add(() => order.push(2));
    el.click();
    expect(handler).toHaveBeenCalledTimes(1);
    d.dispose();
    el.click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(order).toEqual([2, 1]);
  });
});
