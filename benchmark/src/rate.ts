// Open-loop rate control with explicit backpressure accounting.
//
// The schedule is fixed by the configured target: by time t, floor(rate * t) + 1 events are due.
// Events that are due while the in-flight window is full are NOT queued (that would hide
// overload and grow memory without bound). They are counted as `notSentBackpressure`, so the
// achieved rate honestly falls below the target instead of the generator pretending to keep up.

export class RateController {
  private scheduled = 0; // events accounted for (issued + skipped)
  issued = 0;
  notSentBackpressure = 0;

  constructor(
    readonly targetPerSecond: number,
    private readonly startMs: number,
  ) {
    if (!(targetPerSecond > 0)) throw new Error("target rate must be positive");
  }

  /**
   * Events due by `nowMs` that have not been issued or skipped yet. Event k is due at
   * k / rate seconds (k = 0, 1, ...), so a stage of D seconds schedules exactly rate × D events.
   */
  due(nowMs: number): number {
    const elapsed = Math.max(0, nowMs - this.startMs);
    return Math.max(0, Math.floor((this.targetPerSecond * elapsed) / 1000) + 1 - this.scheduled);
  }

  /**
   * Decide how many of the due events to send now, given free in-flight capacity.
   * Returns the number to send; the rest are recorded as skipped for backpressure.
   */
  take(nowMs: number, capacity: number): number {
    const due = this.due(nowMs);
    const send = Math.max(0, Math.min(due, capacity));
    this.scheduled += due;
    this.issued += send;
    this.notSentBackpressure += due - send;
    return send;
  }
}

/** Round-robin rover assignment: every rover gets an equal share of the stage's events. */
export class RoverCursor {
  private next = 0;
  private readonly seq: Uint32Array;
  constructor(readonly rovers: number) {
    if (!Number.isInteger(rovers) || rovers < 1) throw new Error("rovers must be a positive integer");
    this.seq = new Uint32Array(rovers);
  }
  take(): { roverIndex: number; roverSeq: number } {
    const roverIndex = this.next;
    this.next = (this.next + 1) % this.rovers;
    return { roverIndex, roverSeq: this.seq[roverIndex]++ };
  }
}
