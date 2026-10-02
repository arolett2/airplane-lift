/**
 * Smooth camera transitions. The camera is described by (position, target); the tween
 * interpolates the target linearly, the orbit radius logarithmically and the viewing direction
 * with a spherical slerp, so flying between opposite views swings AROUND the model rather than
 * cutting straight through it. No allocations after construction.
 */
import * as THREE from 'three';
import { easeInOutCubic } from './math';

export const DEFAULT_TWEEN_SECONDS = 0.9;

export class CameraTween {
  private active = false;
  private elapsed = 0;
  private duration = DEFAULT_TWEEN_SECONDS;

  private readonly fromTarget = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private readonly fromDir = new THREE.Vector3();
  private fromLogDist = 0;
  private toLogDist = 0;
  private readonly qFull = new THREE.Quaternion();
  private readonly qStep = new THREE.Quaternion();
  private readonly qIdentity = new THREE.Quaternion();
  private readonly dir = new THREE.Vector3();
  private readonly toDir = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();

  get isActive(): boolean {
    return this.active;
  }

  /** Begin a tween between two camera poses. */
  start(
    fromPos: THREE.Vector3,
    fromTarget: THREE.Vector3,
    toPos: THREE.Vector3,
    toTarget: THREE.Vector3,
    durationSeconds = DEFAULT_TWEEN_SECONDS,
  ): void {
    this.fromTarget.copy(fromTarget);
    this.toTarget.copy(toTarget);
    this.fromDir.copy(fromPos).sub(fromTarget);
    const d0 = Math.max(1e-6, this.fromDir.length());
    this.fromDir.divideScalar(d0);
    this.toDir.copy(toPos).sub(toTarget);
    const d1 = Math.max(1e-6, this.toDir.length());
    this.toDir.divideScalar(d1);
    this.fromLogDist = Math.log(d0);
    this.toLogDist = Math.log(d1);

    if (this.fromDir.dot(this.toDir) < -0.9999) {
      // Opposite directions: pick a well-defined axis. Swing around the side (about world Z),
      // or about X when the views are the top/bottom poles.
      if (Math.abs(this.fromDir.z) > 0.99) this.axis.set(1, 0, 0);
      else this.axis.set(0, 0, 1);
      this.qFull.setFromAxisAngle(this.axis, Math.PI);
    } else {
      this.qFull.setFromUnitVectors(this.fromDir, this.toDir);
    }
    this.elapsed = 0;
    this.duration = Math.max(1e-3, durationSeconds);
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  /**
   * Advance the tween and write the new pose. Returns false when no tween is running (outputs
   * untouched). The final call lands exactly on the destination pose.
   */
  update(dtSeconds: number, outPosition: THREE.Vector3, outTarget: THREE.Vector3): boolean {
    if (!this.active) return false;
    this.elapsed += Math.max(0, dtSeconds);
    const t = Math.min(1, this.elapsed / this.duration);
    const e = easeInOutCubic(t);

    outTarget.lerpVectors(this.fromTarget, this.toTarget, e);
    this.qStep.copy(this.qIdentity).slerp(this.qFull, e);
    this.dir.copy(this.fromDir).applyQuaternion(this.qStep);
    const dist = Math.exp(this.fromLogDist + (this.toLogDist - this.fromLogDist) * e);
    outPosition.copy(this.dir).multiplyScalar(dist).add(outTarget);

    if (t >= 1) {
      this.active = false;
      outPosition.copy(this.toDir).multiplyScalar(Math.exp(this.toLogDist)).add(this.toTarget);
      outTarget.copy(this.toTarget);
    }
    return true;
  }
}
