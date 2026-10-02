import { describe, expect, it } from 'vitest';
import { bodyToTunnel, tunnelToBody } from './frames';

describe('frames', () => {
  it('pitches the leading edge up for positive alpha', () => {
    const le = bodyToTunnel([-1, 0, 0], [0, 0, 0], (10 * Math.PI) / 180);
    expect(le[2]).toBeGreaterThan(0);
    expect(le[0]).toBeLessThan(0);
  });

  it('round-trips through the inverse', () => {
    const p: [number, number, number] = [1.2, -3, 0.4];
    const q = tunnelToBody(bodyToTunnel(p, [0.5, 0, 0.1], 0.3), [0.5, 0, 0.1], 0.3);
    q.forEach((v, i) => expect(v).toBeCloseTo(p[i]!, 12));
  });
});
