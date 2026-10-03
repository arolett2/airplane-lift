// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LineChart, type ChartConfig } from './LineChart';
import {
  installFakeCanvas,
  installFixedResizeObserver,
  nextFrames,
  type FakeCanvas,
} from './testCanvas';

let fake: FakeCanvas;
let restoreObserver: () => void;
let host: HTMLElement;

beforeEach(() => {
  fake = installFakeCanvas();
  restoreObserver = installFixedResizeObserver(320, 200);
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  fake.restore();
  restoreObserver();
  host.remove();
});

const config = (): ChartConfig => ({
  x: { label: 'Angle of attack (°)', short: 'Angle' },
  y: { label: 'Lift coefficient', short: 'CL' },
  series: [
    { id: 'a', label: 'Your wing', x: [0, 5, 10], y: [0.1, 0.6, 1.1], color: 'var(--series-1)' },
    {
      id: 'b',
      label: 'Endless wing',
      x: [0, 5, 10],
      y: [0.2, 0.8, 1.4],
      color: '#ff0000',
      dash: [4, 3],
    },
  ],
  markers: [{ x: 5, y: 0.6, color: 'var(--lift)', label: 'You are here' }],
  vlines: [{ x: 8, label: 'Stall' }],
  hlines: [{ y: 1, label: 'Limit' }],
  bands: [{ x: [0, 5, 10], y0: [0.1, 0.6, 1.1], y1: [0.2, 0.8, 1.4], color: '#00ff00' }],
});

describe('LineChart', () => {
  it('adds an accessible canvas and draws labels, legend and annotations', async () => {
    const chart = new LineChart(host);
    expect(host.querySelector('canvas')).toBe(chart.canvas);
    expect(chart.canvas.getAttribute('role')).toBe('img');
    chart.setConfig(config());
    await nextFrames();
    expect(chart.drawCount).toBe(1);
    expect(chart.canvas.getAttribute('aria-label')).toContain('Lift coefficient');
    for (const text of [
      'Your wing',
      'Endless wing',
      'Angle of attack (°)',
      'Lift coefficient',
      'Stall',
      'Limit',
      'You are here',
    ]) {
      expect(fake.texts).toContain(text);
    }
    chart.destroy();
    expect(host.querySelector('canvas')).toBeNull();
  });

  it('draws the lines dashed when asked', async () => {
    const chart = new LineChart(host);
    chart.setConfig(config());
    await nextFrames();
    expect(fake.counts.setLineDash).toBeGreaterThan(0);
    chart.destroy();
  });

  it('coalesces redraw requests and only redraws on change', async () => {
    const chart = new LineChart(host);
    chart.setConfig(config());
    chart.invalidate();
    chart.invalidate();
    chart.setConfig(config());
    await nextFrames();
    expect(chart.drawCount).toBe(1);
    await nextFrames(3);
    expect(chart.drawCount).toBe(1); // nothing changed, nothing redrawn
    chart.setSize(320, 200); // same size: still nothing
    await nextFrames();
    expect(chart.drawCount).toBe(1);
    chart.setSize(400, 220);
    await nextFrames();
    expect(chart.drawCount).toBe(2);
    chart.destroy();
  });

  it('does not draw while its container is hidden (zero size)', async () => {
    restoreObserver();
    restoreObserver = installFixedResizeObserver(0, 0);
    const chart = new LineChart(host);
    chart.setConfig(config());
    await nextFrames();
    expect(chart.drawCount).toBe(0);
    chart.setSize(300, 180);
    await nextFrames();
    expect(chart.drawCount).toBe(1);
    chart.destroy();
  });

  it('inverts the y axis when asked (suction up)', async () => {
    const chart = new LineChart(host);
    const cfg = config();
    chart.setConfig(cfg);
    await nextFrames();
    const normal = chart.getLayout()!;
    expect(normal.yScale.map(normal.yScale.d1)).toBeLessThan(normal.yScale.map(normal.yScale.d0));
    chart.setConfig({ ...cfg, y: { ...cfg.y, inverted: true } });
    await nextFrames();
    const inv = chart.getLayout()!;
    expect(inv.yScale.map(inv.yScale.d1)).toBeGreaterThan(inv.yScale.map(inv.yScale.d0));
    chart.destroy();
  });

  it('shows a hover tooltip with values of the nearest sample', async () => {
    const chart = new LineChart(host);
    chart.setConfig(config());
    await nextFrames();
    const layout = chart.getLayout()!;
    chart.canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 320,
        bottom: 200,
        width: 320,
        height: 200,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    fake.reset();
    const x = layout.xScale.map(5);
    const y = layout.yScale.map(0.6);
    chart.canvas.dispatchEvent(
      new MouseEvent('pointermove', { clientX: x + 2, clientY: y + 1, bubbles: true }),
    );
    await nextFrames();
    expect(chart.drawCount).toBe(2);
    expect(fake.texts.some((t) => t.startsWith('Angle = 5'))).toBe(true);
    expect(fake.texts).toContain('Your wing: 0.600');
    expect(fake.texts).toContain('Endless wing: 0.800');
    // Same target again: no extra redraw.
    chart.canvas.dispatchEvent(
      new MouseEvent('pointermove', { clientX: x + 3, clientY: y + 1, bubbles: true }),
    );
    await nextFrames();
    expect(chart.drawCount).toBe(2);
    // Leaving clears the tooltip.
    chart.canvas.dispatchEvent(new MouseEvent('pointerleave'));
    fake.reset();
    await nextFrames();
    expect(chart.drawCount).toBe(3);
    expect(fake.texts.some((t) => t.startsWith('Angle ='))).toBe(false);
    chart.destroy();
  });

  it('skips non-finite samples without throwing', async () => {
    const chart = new LineChart(host);
    chart.setConfig({
      x: { label: 'x' },
      y: { label: 'y' },
      series: [
        {
          id: 's',
          label: 's',
          x: [0, NaN, 2, 3],
          y: [0, 1, NaN, 3],
          color: '#fff',
          style: 'line+points',
        },
      ],
    });
    await nextFrames();
    expect(chart.drawCount).toBe(1);
    chart.destroy();
  });
});
