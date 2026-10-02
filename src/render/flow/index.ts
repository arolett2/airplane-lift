/**
 * Flow visualisation: smoke streamlines, timeline pulses and the particle "dust".
 *
 * Wiring (see docs/MODULE_APIS.md):
 *   const rate = simSecondsPerSecond(domain, flow.airspeed, view.playbackSpeed); // 0 when paused
 *   simTime += rate * realDt;                       // once per frame
 *   streamlines.update(simTime, rate * realDt);     // sim seconds
 *   particles.update(rate * realDt);
 * Both classes keep their own state between result updates: call setStreamlines / setField /
 * setDomain only when new physics results arrive.
 */
export { simSecondsPerSecond, freestreamTransitTime, TUNNEL_CROSSING_SECONDS } from './playback';
export { StreamlineRenderer } from './StreamlineRenderer';
export type { StreamlineRendererOptions } from './StreamlineRenderer';
export { ParticleSystem } from './ParticleSystem';
export type { ParticleSystemOptions } from './ParticleSystem';
export { positionAtTime } from './pathSampling';
