/**
 * Per-frame animation hook convention.
 *
 * `SceneManager` calls `object.userData.onFrame(dtSeconds, elapsedSeconds)` once per rendered
 * frame for every VISIBLE object in the scene that defines it. This lets render classes animate
 * (smoothing, spinning fans) without the app having to forward ticks to each of them.
 */
import type * as THREE from 'three';

export type FrameTickFn = (dtSeconds: number, elapsedSeconds: number) => void;

export function setFrameTick(obj: THREE.Object3D, fn: FrameTickFn | null): void {
  if (fn) obj.userData.onFrame = fn;
  else delete obj.userData.onFrame;
}

export function getFrameTick(obj: THREE.Object3D): FrameTickFn | undefined {
  const fn: unknown = obj.userData.onFrame;
  return typeof fn === 'function' ? (fn as FrameTickFn) : undefined;
}
