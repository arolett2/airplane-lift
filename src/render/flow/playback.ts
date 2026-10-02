/**
 * Mapping between wall-clock time and simulated (physical) time for the flow animations.
 */
import type { TunnelDomain } from '../../physics/domain';

/** Real seconds the freestream takes to cross the tunnel at playbackSpeed = 1. */
export const TUNNEL_CROSSING_SECONDS = 4;

/** Physical time (s) the freestream needs to cross the tunnel test section. */
export function freestreamTransitTime(domain: TunnelDomain, vInf: number): number {
  return (domain.max[0] - domain.min[0]) / Math.max(vInf, 1e-3);
}

/**
 * Simulated seconds per real second: air crosses the tunnel in ~4 s at playbackSpeed 1.
 * The animation therefore looks the same for a Cessna and a 747; only the physical clock
 * (and the speed-dependent flow field) differ.
 */
export function simSecondsPerSecond(
  domain: TunnelDomain,
  vInf: number,
  playbackSpeed: number,
): number {
  return (freestreamTransitTime(domain, vInf) / TUNNEL_CROSSING_SECONDS) * playbackSpeed;
}
