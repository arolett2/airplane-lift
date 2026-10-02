/**
 * Pure geometry helpers for the wind-tunnel scenery (no three.js): grid lines, the inlet
 * honeycomb and the glass-wall ribs, as flat Float32Arrays of line segments.
 * Everything is in the TUNNEL frame, meters.
 */
import type { TunnelDomain } from '../../physics/domain';

/** A "nice" 1-2-5 step so that roughly `targetCount` steps span `range`. */
export function niceStep(range: number, targetCount: number): number {
  const raw = Math.max(1e-9, range) / Math.max(1, targetCount);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nice * pow;
}

/** Dimensions of the test section and the span the domain was sized from. */
export function tunnelDims(domain: TunnelDomain) {
  const lx = domain.max[0] - domain.min[0];
  const ly = domain.max[1] - domain.min[1];
  const lz = domain.max[2] - domain.min[2];
  return {
    lx,
    ly,
    lz,
    cx: 0.5 * (domain.min[0] + domain.max[0]),
    cy: 0.5 * (domain.min[1] + domain.max[1]),
    cz: 0.5 * (domain.min[2] + domain.max[2]),
    /** tunnelDomain() makes the width 1.5 x the overall span. */
    span: ly / 1.5,
  };
}

/**
 * Liang-Barsky clip of segment (x0,y0)-(x1,y1) to a rectangle. Writes the clipped segment into
 * `out` (length 4) and returns true, or returns false when nothing remains.
 */
export function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  out: number[],
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - minX, maxX - x0, y0 - minY, maxY - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return false;
    } else {
      const r = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  if (t1 - t0 < 1e-9) return false;
  out[0] = x0 + t0 * dx;
  out[1] = y0 + t0 * dy;
  out[2] = x0 + t1 * dx;
  out[3] = y0 + t1 * dy;
  return true;
}

/**
 * Hexagonal honeycomb cells clipped to the rectangle [0,w] x [0,h] (cell-local coordinates),
 * as segment endpoint pairs (u0,v0,u1,v1,...). Every shared edge appears exactly once.
 * @param cell hexagon height flat-to-flat... pointy-top, `radius` = centre-to-vertex distance
 */
export function honeycombSegments(w: number, h: number, radius: number): Float32Array {
  const out: number[] = [];
  const seg = [0, 0, 0, 0];
  const dx = Math.sqrt(3) * radius; // horizontal pitch
  const dy = 1.5 * radius; // vertical pitch
  const rows = Math.ceil(h / dy) + 2;
  const cols = Math.ceil(w / dx) + 2;
  // Pointy-top vertices at angles 30 + 60k degrees.
  const vx: number[] = [];
  const vy: number[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (30 + 60 * k);
    vx.push(radius * Math.cos(a));
    vy.push(radius * Math.sin(a));
  }
  for (let r = -1; r < rows; r++) {
    for (let c = -1; c < cols; c++) {
      const cx = c * dx + (r & 1 ? 0.5 * dx : 0);
      const cy = r * dy;
      // Emit edges e0 (v0-v1), e1 (v1-v2), e2 (v2-v3): each shared edge is owned by one hex.
      for (let e = 0; e < 3; e++) {
        const a = e;
        const b = e + 1;
        if (clipSegment(cx + vx[a]!, cy + vy[a]!, cx + vx[b]!, cy + vy[b]!, 0, 0, w, h, seg)) {
          out.push(seg[0]!, seg[1]!, seg[2]!, seg[3]!);
        }
      }
    }
  }
  return Float32Array.from(out);
}

/** Unique hexagon corner points inside the rectangle (for the depth connectors). */
export function honeycombVertices(w: number, h: number, radius: number): Float32Array {
  const dx = Math.sqrt(3) * radius;
  const dy = 1.5 * radius;
  const rows = Math.ceil(h / dy) + 2;
  const cols = Math.ceil(w / dx) + 2;
  const seen = new Set<string>();
  const out: number[] = [];
  for (let r = -1; r < rows; r++) {
    for (let c = -1; c < cols; c++) {
      const cx = c * dx + (r & 1 ? 0.5 * dx : 0);
      const cy = r * dy;
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (30 + 60 * k);
        const x = cx + radius * Math.cos(a);
        const y = cy + radius * Math.sin(a);
        if (x < 0 || x > w || y < 0 || y > h) continue;
        const key = `${Math.round((x / radius) * 1000)},${Math.round((y / radius) * 1000)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(x, y);
      }
    }
  }
  return Float32Array.from(out);
}

export interface GridLines {
  /** xyz endpoints, two per segment. */
  positions: Float32Array;
  /** Per-vertex brightness 0..1 (fades toward the floor edges; major lines brighter). */
  brightness: Float32Array;
}

/**
 * Floor grid in the XY plane at `domain.min[2]`, aligned to multiples of `step` so a line always
 * passes under the wing root. Lines are split into short pieces so brightness can fade smoothly
 * toward the edges of the floor.
 */
export function floorGrid(domain: TunnelDomain, step: number, majorEvery = 5): GridLines {
  const { cx, cy, lx, ly } = tunnelDims(domain);
  const z = domain.min[2];
  const pos: number[] = [];
  const bri: number[] = [];
  const fade = (x: number, y: number) => {
    const nx = Math.abs(x - cx) / (0.5 * lx);
    const ny = Math.abs(y - cy) / (0.5 * ly);
    const d = Math.max(nx, ny);
    const t = Math.min(1, Math.max(0, (d - 0.55) / 0.45));
    return 1 - t * t * (3 - 2 * t);
  };
  const addLine = (x0: number, y0: number, x1: number, y1: number, strength: number) => {
    const pieces = 24;
    for (let i = 0; i < pieces; i++) {
      const a = i / pieces;
      const b = (i + 1) / pieces;
      const ax = x0 + (x1 - x0) * a;
      const ay = y0 + (y1 - y0) * a;
      const bx = x0 + (x1 - x0) * b;
      const by = y0 + (y1 - y0) * b;
      pos.push(ax, ay, z, bx, by, z);
      bri.push(strength * fade(ax, ay), strength * fade(bx, by));
    }
  };
  const iMinX = Math.ceil(domain.min[0] / step);
  const iMaxX = Math.floor(domain.max[0] / step);
  for (let i = iMinX; i <= iMaxX; i++) {
    addLine(i * step, domain.min[1], i * step, domain.max[1], i % majorEvery === 0 ? 1 : 0.5);
  }
  const iMinY = Math.ceil(domain.min[1] / step);
  const iMaxY = Math.floor(domain.max[1] / step);
  for (let j = iMinY; j <= iMaxY; j++) {
    addLine(domain.min[0], j * step, domain.max[0], j * step, j % majorEvery === 0 ? 1 : 0.5);
  }
  return { positions: Float32Array.from(pos), brightness: Float32Array.from(bri) };
}

/** The 12 edges of the test-section box. */
export function boxEdges(domain: TunnelDomain): Float32Array {
  const [x0, y0, z0] = domain.min;
  const [x1, y1, z1] = domain.max;
  const c = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ] as const;
  const pairs = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ] as const;
  const out: number[] = [];
  for (const [a, b] of pairs) out.push(...c[a], ...c[b]);
  return Float32Array.from(out);
}

/**
 * Glass-frame ribs: at `count` stations along x (excluding the end faces), a loop up the left
 * wall, across the ceiling and down the right wall (open at the floor).
 */
export function wallRibs(domain: TunnelDomain, count: number): Float32Array {
  const [x0, y0, z0] = domain.min;
  const [x1, y1, z1] = domain.max;
  const out: number[] = [];
  for (let k = 1; k <= count; k++) {
    const x = x0 + ((x1 - x0) * k) / (count + 1);
    out.push(x, y0, z0, x, y0, z1);
    out.push(x, y0, z1, x, y1, z1);
    out.push(x, y1, z1, x, y1, z0);
  }
  return Float32Array.from(out);
}
