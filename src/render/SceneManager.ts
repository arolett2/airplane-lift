/**
 * Owns the three.js renderer, Z-UP camera + OrbitControls, lights, render loop, resize, and the
 * `modelRoot` group. Everything in physics meters (wing, flow, forces, tunnel) is added to
 * `modelRoot`, which is uniformly scaled so the wing always fills the view.
 * OWNER: render-scene agent. CONTRACT — keep the public members.
 */
import type * as THREE from 'three';
import type { CameraShot } from '../state/params';
import type { TunnelDomain } from '../physics/domain';

export type FrameCallback = (dtSeconds: number, elapsedSeconds: number) => void;

export interface SceneManagerApi {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Physics-meter space. Scaled so the tunnel domain maps to a fixed display size. */
  readonly modelRoot: THREE.Group;
  /** Rescale modelRoot for a new tunnel domain and keep the camera framing sensible. */
  setDomain(domain: TunnelDomain): void;
  /** Smoothly fly the camera to a named shot (framed on the current domain). */
  flyTo(shot: CameraShot): void;
  /** Register a per-frame callback; returns an unsubscribe function. */
  onFrame(cb: FrameCallback): () => void;
  /** Average frames per second over the last second (for adaptive quality). */
  readonly fps: number;
  dispose(): void;
}
