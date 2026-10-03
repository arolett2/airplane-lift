// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PressureLegend } from './PressureLegend';

describe('PressureLegend', () => {
  it('explains the colours in plain words and follows the colour mode', () => {
    const host = document.createElement('div');
    const legend = new PressureLegend(host);
    expect(host.textContent).toContain('Low pressure · fast air');
    expect(host.textContent).toContain('High pressure · slowed air');
    expect(legend.element.getAttribute('role')).toBe('img');
    expect(legend.element.getAttribute('aria-label')).toMatch(/blue means low pressure/);
    legend.setMode('speed');
    expect(host.textContent).toContain('Fast air');
    legend.dispose();
    expect(host.children).toHaveLength(0);
  });

  it('is placed by the app, can go compact and hides', () => {
    const host = document.createElement('div');
    const legend = new PressureLegend(host);
    legend.setPlacement(420, 30);
    expect(legend.element.style.left).toBe('420px');
    expect(legend.element.style.bottom).toBe('30px');
    legend.setPlacement(100, 60, true);
    expect(legend.element.style.top).toBe('60px');
    expect(legend.element.style.bottom).toBe('auto');
    legend.setCompact(true);
    expect(legend.element.style.gridTemplateRows).toBe('auto auto');
    legend.setVisible(false);
    expect(legend.element.style.display).toBe('none');
    legend.setVisible(true);
    expect(legend.element.style.display).toBe('grid');
    legend.dispose();
  });
});
