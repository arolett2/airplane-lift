/**
 * Smoke streamlines: each Streamline3D is drawn as a smooth, screen-space-width line, with
 * animated "puffs" released at a fixed TIME interval riding along it and optional "timeline"
 * pulses that put one bright marker on every line at the same instant.
 *
 * Because puffs are released at fixed time intervals and move along each line by its own time[]
 * array, they spread apart where the air is fast (over the top of the wing) and bunch up where it
 * is slow. A timeline pulse makes the same point at a glance: the marker above the wing reaches
 * the trailing edge before the one below (air does NOT take equal time over both surfaces).
 *
 * Buffers are rebuilt only in setStreamlines; update() only rewrites small per-puff arrays.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  Points,
  Vector2,
  type InterleavedBufferAttribute,
  type ShaderMaterial,
  type WebGLRenderer,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Streamline3D } from '../../physics/types';
import type { ColorBy } from '../../state/params';
import { getColorLut, lutIndex, type ColorLut } from './flowColors';
import { pathDuration, pathLength, sampleLineAtTime } from './pathSampling';
import { bindSpriteViewport, createSpriteMaterial } from './sprites';

/** Puffs released per freestream transit of the tunnel (sets the puff spacing in still air). */
export const PUFFS_PER_TRANSIT = 40;
/** Hard cap on puffs per line (very slow lines, e.g. near a stagnation point). */
const MAX_PUFFS_PER_LINE = 4 * PUFFS_PER_TRANSIT;
/** Timelines that may exist at once; firing more drops the oldest. */
export const MAX_PULSES = 6;
/** A pulse marker stops following its line after this many freestream transits. */
const PULSE_MAX_TRANSITS = 2.5;
/** After reaching the end of its line a pulse marker fades over this fraction of a transit. */
const PULSE_FADE_TRANSITS = 0.18;
/** Pulse markers are washed this far toward white so they read as "bright". */
const PULSE_WHITEN = 0.55;

const LINE_WIDTH_PX = 2;
const LINE_OPACITY = 0.9;

export interface StreamlineRendererOptions {
  /** Additive blending for puffs (suits dark backgrounds); default normal blending. */
  additive?: boolean;
}

/** Per-line bookkeeping, computed once in setStreamlines. */
interface LineInfo {
  line: Streamline3D;
  /** Vertices actually usable (0 = the line is skipped). */
  n: number;
  /** time[0]; ages are measured from here. */
  time0: number;
  /** Total travel time of the line (s). */
  duration: number;
  /** Puff slot range in the puff buffers. */
  puffStart: number;
  puffCount: number;
  /** Release phase in [0, puffInterval): keeps lines from emitting puffs in lockstep. */
  phase: number;
}

interface Pulse {
  /** Simulation time at which the timeline was released. */
  t0: number;
}

export class StreamlineRenderer {
  readonly object = new Group();

  private readonly lineMaterial: LineMaterial;
  private lineMesh: LineSegments2 | null = null;
  private lineColors: Float32Array = new Float32Array(0);
  private linePositions: Float32Array = new Float32Array(0);

  private readonly puffMaterial: ShaderMaterial;
  private readonly puffPoints: Points;
  private puffGeometry = new BufferGeometry();
  private puffPos: Float32Array = new Float32Array(0);
  private puffColor: Float32Array = new Float32Array(0);
  private puffAlpha: Float32Array = new Float32Array(0);
  private puffSize: Float32Array = new Float32Array(0);

  private readonly pulseMaterial: ShaderMaterial;
  private readonly pulsePoints: Points;
  private pulseGeometry = new BufferGeometry();
  private pulsePos: Float32Array = new Float32Array(0);
  private pulseColor: Float32Array = new Float32Array(0);
  private pulseAlpha: Float32Array = new Float32Array(0);

  private infos: LineInfo[] = [];
  private pulses: Pulse[] = [];
  private colorBy: ColorBy = 'pressure';
  private lut: ColorLut = getColorLut('pressure');
  private visible = true;
  private simTime = 0;
  private vInf = 1;
  /** Freestream transit time (s) estimated from the lines' extent. */
  private transit = 1;
  private puffInterval = 1;
  private longestDuration = 0;
  private dirty = true;
  private lastDrawnTime = NaN;
  private readonly scratchSize = new Vector2();

  constructor(options: StreamlineRendererOptions = {}) {
    const additive = options.additive ?? false;
    this.object.name = 'StreamlineRenderer';

    this.lineMaterial = new LineMaterial({
      color: 0xffffff,
      linewidth: LINE_WIDTH_PX,
      worldUnits: false,
      vertexColors: true,
      transparent: true,
      opacity: LINE_OPACITY,
      depthWrite: false,
    });

    this.puffMaterial = createSpriteMaterial({
      worldSize: 1,
      minPx: 4,
      maxPx: 22,
      core: 0,
      opacity: 0.85,
      additive,
    });
    this.puffPoints = new Points(this.puffGeometry, this.puffMaterial);
    this.puffPoints.frustumCulled = false;
    this.puffPoints.renderOrder = 2;
    bindSpriteViewport(this.puffPoints, this.puffMaterial, 4, 22);
    this.object.add(this.puffPoints);

    this.pulseMaterial = createSpriteMaterial({
      worldSize: 1,
      minPx: 9,
      maxPx: 36,
      core: 0.9,
      opacity: 1,
      additive,
    });
    this.pulsePoints = new Points(this.pulseGeometry, this.pulseMaterial);
    this.pulsePoints.frustumCulled = false;
    this.pulsePoints.renderOrder = 3;
    bindSpriteViewport(this.pulsePoints, this.pulseMaterial, 9, 36);
    this.object.add(this.pulsePoints);
  }

  /** Number of puff slots currently allocated (for tests/diagnostics). */
  get puffSlots(): number {
    return this.puffAlpha.length;
  }

  /** Puff slots [start, start + count) in the puff buffers that belong to line `index`. */
  puffRange(index: number): [number, number] {
    const info = this.infos[index];
    return info ? [info.puffStart, info.puffCount] : [0, 0];
  }

  /** Time between puff releases on every line (s). */
  get puffReleaseInterval(): number {
    return this.puffInterval;
  }

  /** Timelines currently in flight. */
  get activePulses(): number {
    return this.pulses.length;
  }

  setStreamlines(lines: Streamline3D[] | null, vInf: number): void {
    this.vInf = vInf > 0 ? vInf : 1;
    this.disposeLineMesh();
    this.infos = [];
    if (!lines || lines.length === 0) {
      this.pulses = [];
      this.allocateAnimated(0);
      this.lineMesh = null;
      this.dirty = true;
      return;
    }

    // Pass 1: usable lines, segment totals, extent in x (the tunnel length the air crosses).
    let segments = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    const durations: number[] = [];
    for (const line of lines) {
      const n = pathLength(line);
      const usable = n >= 2;
      this.infos.push({
        line,
        n: usable ? n : 0,
        time0: usable ? line.time[0]! : 0,
        duration: usable ? pathDuration(line) : 0,
        puffStart: 0,
        puffCount: 0,
        phase: 0,
      });
      if (!usable) continue;
      segments += n - 1;
      durations.push(pathDuration(line));
      const p = line.points;
      for (let i = 0; i < n; i++) {
        const x = p[i * 3]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }

    // Time scales: freestream transit and the (fixed) puff release interval.
    durations.sort((a, b) => a - b);
    this.longestDuration = durations.length ? durations[durations.length - 1]! : 0;
    const medianDuration = durations.length ? durations[durations.length >> 1]! : 1;
    this.transit = maxX > minX && vInf > 0 ? (maxX - minX) / vInf : Math.max(medianDuration, 1e-3);
    this.puffInterval = this.transit / PUFFS_PER_TRANSIT;

    // Pass 2: line geometry (one LineSegments2 draw call for everything).
    if (segments > 0) this.buildLineGeometry(segments);

    // Pass 3: puff slots per line.
    let puffs = 0;
    for (let li = 0; li < this.infos.length; li++) {
      const info = this.infos[li]!;
      if (info.n < 2) continue;
      info.puffCount = Math.min(
        MAX_PUFFS_PER_LINE,
        Math.floor(info.duration / this.puffInterval) + 2,
      );
      info.puffStart = puffs;
      puffs += info.puffCount;
      info.phase = hash01(li) * this.puffInterval;
    }
    this.allocateAnimated(puffs);
    this.recolorLines();
    this.dirty = true;
    this.refresh(this.simTime);
  }

  setColorBy(mode: ColorBy): void {
    if (mode === this.colorBy) return;
    this.colorBy = mode;
    this.lut = getColorLut(mode);
    this.recolorLines();
    this.dirty = true;
    this.refresh(this.simTime);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.object.visible = on;
    if (on) {
      this.dirty = true;
      this.refresh(this.simTime);
    }
  }

  /** Release a "timeline": one marker on every streamline at the same instant. */
  firePulse(): void {
    if (!this.infos.some((i) => i.n >= 2)) return;
    this.pulses.push({ t0: this.simTime });
    if (this.pulses.length > MAX_PULSES) this.pulses.shift();
    this.dirty = true;
    this.refresh(this.simTime);
  }

  /** Advance animation; simTime/dtSim are physical seconds. */
  update(simTime: number, _dtSim: number): void {
    this.simTime = simTime;
    if (!this.visible) return;
    this.refresh(simTime);
  }

  dispose(): void {
    this.disposeLineMesh();
    this.lineMaterial.dispose();
    this.puffGeometry.dispose();
    this.pulseGeometry.dispose();
    this.puffMaterial.dispose();
    this.pulseMaterial.dispose();
    this.object.clear();
    this.infos = [];
    this.pulses = [];
  }

  /* ---------------------------------------------------------------------------------------- */

  private refresh(simTime: number): void {
    if (this.infos.length === 0) return;
    if (!this.dirty && simTime === this.lastDrawnTime) return;
    this.lastDrawnTime = simTime;
    this.dirty = false;
    this.updatePuffs(simTime);
    this.updatePulses(simTime);
  }

  private buildLineGeometry(segments: number): void {
    const floats = segments * 6;
    if (this.linePositions.length !== floats) {
      this.linePositions = new Float32Array(floats);
      this.lineColors = new Float32Array(floats);
    }
    const pos = this.linePositions;
    let o = 0;
    for (const info of this.infos) {
      if (info.n < 2) continue;
      const p = info.line.points;
      for (let i = 0; i < info.n - 1; i++) {
        const a = i * 3;
        pos[o++] = p[a]!;
        pos[o++] = p[a + 1]!;
        pos[o++] = p[a + 2]!;
        pos[o++] = p[a + 3]!;
        pos[o++] = p[a + 4]!;
        pos[o++] = p[a + 5]!;
      }
    }
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(pos);
    geometry.setColors(this.lineColors);
    const mesh = new LineSegments2(geometry, this.lineMaterial);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.getSize(this.scratchSize);
      this.lineMaterial.resolution.set(this.scratchSize.x, this.scratchSize.y);
    };
    this.lineMesh = mesh;
    this.object.add(mesh);
  }

  /** Rewrite the per-vertex colours of the lines in place (cheap: no geometry rebuild). */
  private recolorLines(): void {
    const mesh = this.lineMesh;
    if (!mesh) return;
    const lut = this.lut.rgb;
    const col = this.lineColors;
    let o = 0;
    for (const info of this.infos) {
      if (info.n < 2) continue;
      const speed = info.line.speed;
      const hasSpeed = speed.length >= info.n;
      for (let i = 0; i < info.n - 1; i++) {
        const c0 = lutIndex(hasSpeed ? speed[i]! : 1) * 3;
        const c1 = lutIndex(hasSpeed ? speed[i + 1]! : 1) * 3;
        col[o++] = lut[c0]!;
        col[o++] = lut[c0 + 1]!;
        col[o++] = lut[c0 + 2]!;
        col[o++] = lut[c1]!;
        col[o++] = lut[c1 + 1]!;
        col[o++] = lut[c1 + 2]!;
      }
    }
    const attr = mesh.geometry.getAttribute('instanceColorStart') as InterleavedBufferAttribute;
    attr.data.needsUpdate = true;
  }

  /** (Re)allocate the puff and pulse-marker buffers. */
  private allocateAnimated(puffs: number): void {
    this.puffGeometry.dispose();
    const puff = makeSpriteBuffers(puffs);
    this.puffGeometry = puff.geometry;
    this.puffPos = puff.pos;
    this.puffColor = puff.color;
    this.puffAlpha = puff.alpha;
    this.puffSize = puff.size;
    this.puffPoints.geometry = this.puffGeometry;
    // Sprite sizes are in metres, relative to the tunnel length the lines span.
    const lengthMeters = this.transit * this.vInf;
    this.puffMaterial.uniforms['uWorldSize']!.value = 0.012 * lengthMeters;
    this.pulseMaterial.uniforms['uWorldSize']!.value = 0.024 * lengthMeters;

    this.pulseGeometry.dispose();
    const pulse = makeSpriteBuffers(this.infos.length * MAX_PULSES);
    this.pulseGeometry = pulse.geometry;
    this.pulsePos = pulse.pos;
    this.pulseColor = pulse.color;
    this.pulseAlpha = pulse.alpha;
    this.pulsePoints.geometry = this.pulseGeometry;
  }

  private updatePuffs(simTime: number): void {
    const lut = this.lut.rgb;
    const interval = this.puffInterval;
    const pos = this.puffPos;
    const col = this.puffColor;
    const alpha = this.puffAlpha;
    const size = this.puffSize;
    const fadeInInv = 1 / (0.6 * interval);
    for (const info of this.infos) {
      if (info.puffCount === 0) continue;
      const rel = simTime - info.phase;
      let age = rel - interval * Math.floor(rel / interval); // youngest puff, in [0, interval)
      const duration = info.duration;
      const fadeOutInv = 1 / (3 * interval);
      for (let j = 0; j < info.puffCount; j++, age += interval) {
        const slot = info.puffStart + j;
        const o = slot * 3;
        const speed = age <= duration ? sampleLineAtTime(info.line, info.time0 + age, pos, o) : -1;
        if (speed < 0) {
          alpha[slot] = 0;
          continue;
        }
        const c = lutIndex(speed) * 3;
        col[o] = lut[c]!;
        col[o + 1] = lut[c + 1]!;
        col[o + 2] = lut[c + 2]!;
        let a = age * fadeInInv;
        const fo = (duration - age) * fadeOutInv;
        if (fo < a) a = fo;
        alpha[slot] = a < 0 ? 0 : a > 1 ? 1 : a;
        // Smoke spreads as it ages.
        size[slot] = 0.75 + 0.5 * (duration > 0 ? age / duration : 0);
      }
    }
    flag(this.puffGeometry, ['position', 'aColor', 'aAlpha', 'aSize']);
  }

  private updatePulses(simTime: number): void {
    const n = this.infos.length;
    const lut = this.lut.rgb;
    const pos = this.pulsePos;
    const col = this.pulseColor;
    const alpha = this.pulseAlpha;
    const maxLife = PULSE_MAX_TRANSITS * this.transit;
    const fade = PULSE_FADE_TRANSITS * this.transit;

    // Drop finished (or time-travelled) pulses, then draw the rest into slots 0..k-1.
    const keep: Pulse[] = [];
    for (const pulse of this.pulses) {
      const age = simTime - pulse.t0;
      if (age < -1e-9) continue;
      if (age > Math.min(this.longestDuration, maxLife) + fade) continue;
      keep.push(pulse);
    }
    this.pulses = keep;

    for (let s = 0; s < MAX_PULSES; s++) {
      const pulse = keep[s];
      for (let i = 0; i < n; i++) {
        const slot = s * n + i;
        const info = this.infos[i]!;
        if (!pulse || info.n < 2) {
          alpha[slot] = 0;
          continue;
        }
        const age = simTime - pulse.t0;
        const end = Math.min(info.duration, maxLife);
        const o = slot * 3;
        let speed: number;
        let a = 1;
        if (age <= end) {
          speed = sampleLineAtTime(info.line, info.time0 + age, pos, o);
        } else {
          // Parked at the end of its line, fading out.
          speed = sampleLineAtTime(info.line, info.time0 + end, pos, o);
          a = 1 - (age - end) / fade;
        }
        if (speed < 0) {
          alpha[slot] = 0;
          continue;
        }
        const c = lutIndex(speed) * 3;
        col[o] = lut[c]! + (1 - lut[c]!) * PULSE_WHITEN;
        col[o + 1] = lut[c + 1]! + (1 - lut[c + 1]!) * PULSE_WHITEN;
        col[o + 2] = lut[c + 2]! + (1 - lut[c + 2]!) * PULSE_WHITEN;
        alpha[slot] = a < 0 ? 0 : a;
      }
    }
    flag(this.pulseGeometry, ['position', 'aColor', 'aAlpha']);
  }

  private disposeLineMesh(): void {
    if (!this.lineMesh) return;
    this.object.remove(this.lineMesh);
    this.lineMesh.geometry.dispose();
    this.lineMesh = null;
  }
}

/** Deterministic pseudo-random value in [0, 1) from an integer (per-line release phase). */
function hash01(i: number): number {
  let x = (i + 1) * 0x9e3779b1;
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) % 100000) / 100000;
}

/** Create a Points geometry with the attribute set the sprite shader expects, plus its arrays. */
function makeSpriteBuffers(count: number): {
  geometry: BufferGeometry;
  pos: Float32Array;
  color: Float32Array;
  alpha: Float32Array;
  size: Float32Array;
} {
  const geometry = new BufferGeometry();
  const pos: Float32Array = new Float32Array(count * 3);
  const color: Float32Array = new Float32Array(count * 3);
  const alpha: Float32Array = new Float32Array(count);
  const size: Float32Array = new Float32Array(count).fill(1);
  geometry.setAttribute('position', new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute('aColor', new BufferAttribute(color, 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute('aAlpha', new BufferAttribute(alpha, 1).setUsage(DynamicDrawUsage));
  geometry.setAttribute('aSize', new BufferAttribute(size, 1).setUsage(DynamicDrawUsage));
  geometry.setDrawRange(0, count);
  return { geometry, pos, color, alpha, size };
}

function flag(geometry: BufferGeometry, names: string[]): void {
  for (const name of names) {
    const attr = geometry.getAttribute(name);
    if (attr) attr.needsUpdate = true;
  }
}
