/**
 * Sliding-window frames-per-second meter. The last second is split into four quarter-second
 * buckets so the reading reacts quickly but does not jitter from frame to frame.
 */
export class FpsMeter {
  private static readonly BUCKETS = 4;
  private static readonly BUCKET_SECONDS = 0.25;

  private readonly frames = new Float64Array(FpsMeter.BUCKETS);
  private readonly seconds = new Float64Array(FpsMeter.BUCKETS);
  private head = 0;
  private reading: number;

  /** @param initial value reported until a quarter second of frames has been measured */
  constructor(initial = 60) {
    this.reading = initial;
  }

  /**
   * Record one rendered frame that took `dtSeconds` (unclamped wall-clock time). A frame longer
   * than one bucket (the first frame back from a background tab, a one-off stall) counts as one
   * bucket long: it is a gap, not a frame rate, and must not drag the reading down for a second.
   */
  tick(dtSeconds: number): void {
    if (!(dtSeconds >= 0) || !Number.isFinite(dtSeconds)) return;
    if (this.seconds[this.head]! >= FpsMeter.BUCKET_SECONDS) {
      this.head = (this.head + 1) % FpsMeter.BUCKETS;
      this.frames[this.head] = 0;
      this.seconds[this.head] = 0;
    }
    this.frames[this.head]! += 1;
    this.seconds[this.head]! += Math.min(dtSeconds, FpsMeter.BUCKET_SECONDS);

    let f = 0;
    let s = 0;
    for (let i = 0; i < FpsMeter.BUCKETS; i++) {
      f += this.frames[i]!;
      s += this.seconds[i]!;
    }
    if (s >= FpsMeter.BUCKET_SECONDS) this.reading = f / s;
  }

  /** Average frames per second over (roughly) the last second. */
  get fps(): number {
    return this.reading;
  }
}
