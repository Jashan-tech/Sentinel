// Measurement collector. Every number here is derived from a recorded event:
//   sent        — the generator issued a reducer call (attempted write)
//   acked       — the reducer call's promise resolved: SpacetimeDB committed it and replied Ok
//   rejected    — the reducer replied with a SenderError (validation/authorization refusal)
//   transport   — any other failure (disconnect, internal error): outcome unknown or failed
//   observed    — a subscriber connection received the row through its subscription
// Attempted, acknowledged and observed are tracked separately and never substituted for each other.
// Times come from one monotonic clock (performance.now) in one process, so latencies are
// differences of the same clock, never of unsynchronized machines.
import { percentiles, ratePerSecond, SampleBuffer, type Percentiles } from "./stats";

const enum S {
  None = 0,
  InFlight = 1,
  Acked = 2,
  Rejected = 3,
  Transport = 4,
}

export interface StageResult {
  stageIndex: number;
  roverCount: number;
  targetRate: number;
  startedElapsedMs: number;
  endedElapsedMs: number;
  /**
   * Throughput denominator: from stage start until the later of (a) the end of the send phase and
   * (b) the stage's last acknowledgement. Overload that delays acks lengthens it; it never shrinks.
   */
  sendWindowMs: number;
  attempted: number;
  acknowledged: number;
  rejected: number;
  transportErrors: number;
  unresolved: number;
  notSentBackpressure: number;
  /** (event, subscriber) pairs where an acknowledged event reached that subscriber. */
  observedPairs: number;
  /** acknowledged × subscribers measured for this stage. */
  expectedPairs: number;
  duplicateObservations: number;
  /** Events a subscriber saw although the writer never received an acknowledgement. */
  observedWithoutAck: number;
  achievedRate: number | null;
  ack: Percentiles;
  delivery: Percentiles;
  eventLoopP99Ms: number | null;
  /** Change in SpacetimeDB's own committed bench_write transaction counter over the stage (server-side). */
  serverCommitted: number | null;
  /** Change in SpacetimeDB's failed (not committed) bench_write transaction counter over the stage. */
  serverFailed: number | null;
  rejectionReasons: Record<string, number>;
  complete: boolean;
}

export interface WindowSample {
  stageIndex: number;
  elapsedMs: number;
  windowMs: number;
  windowAcknowledged: number;
  achievedRate: number | null;
  deliveryP95: number | null;
  deliverySamples: number;
  ackP95: number | null;
  totalAttempted: number;
  totalAcknowledged: number;
  totalRejected: number;
  totalTransportErrors: number;
  totalObservedPairs: number;
  inFlight: number;
}

interface StageState {
  index: number;
  rovers: number;
  targetRate: number;
  firstEvent: number;
  endEvent: number; // exclusive; set when sending stops
  startedMs: number;
  firstSendMs: number | null;
  sendEndMs: number | null;
  lastAckMs: number | null;
  attempted: number;
  acknowledged: number;
  rejected: number;
  transport: number;
  observedPairs: number;
  duplicates: number;
  ackLat: SampleBuffer;
  delLat: SampleBuffer;
  reasons: Map<string, number>;
}

export class Collector {
  private sentAt = new Float64Array(1 << 16);
  private state = new Uint8Array(1 << 16);
  private seen = new Uint8Array(1 << 16); // bit s = subscriber s observed this event
  private stageOf = new Uint8Array(1 << 16);
  private next = 0;
  private stages: StageState[] = [];
  private cur: StageState | null = null;
  private readonly fullMask: number;
  // running totals
  totalAttempted = 0;
  totalAcknowledged = 0;
  totalRejected = 0;
  totalTransport = 0;
  totalObservedPairs = 0;
  unexpectedObservations = 0;
  inFlight = 0;
  // current measurement window
  private winStart: number;
  private winAck = 0;
  private winAckLat = new SampleBuffer();
  private winDelLat = new SampleBuffer();

  constructor(
    readonly subscribers: number,
    readonly runStartMs: number,
    readonly maxEvents = 4_000_000,
  ) {
    if (subscribers < 1 || subscribers > 8) throw new Error("1-8 subscribers supported");
    this.fullMask = (1 << subscribers) - 1;
    this.winStart = runStartMs;
  }

  get eventCount() {
    return this.next;
  }

  private grow() {
    const n = this.sentAt.length * 2;
    const g = <T extends Float64Array | Uint8Array>(a: T, C: new (n: number) => T) => {
      const b = new C(n);
      b.set(a);
      return b;
    };
    this.sentAt = g(this.sentAt, Float64Array);
    this.state = g(this.state, Uint8Array);
    this.seen = g(this.seen, Uint8Array);
    this.stageOf = g(this.stageOf, Uint8Array);
  }

  beginStage(index: number, rovers: number, targetRate: number, nowMs: number) {
    if (this.cur) throw new Error("previous stage not ended");
    this.cur = {
      index, rovers, targetRate, firstEvent: this.next, endEvent: -1, startedMs: nowMs,
      firstSendMs: null, sendEndMs: null, lastAckMs: null, attempted: 0, acknowledged: 0, rejected: 0, transport: 0,
      observedPairs: 0, duplicates: 0, ackLat: new SampleBuffer(), delLat: new SampleBuffer(), reasons: new Map(),
    };
    this.stages[index] = this.cur;
  }

  /** Allocate a unique event number and record its send time. Returns null at the event cap. */
  send(nowMs: number): number | null {
    const st = this.cur;
    if (!st || st.endEvent >= 0) throw new Error("no stage is accepting sends");
    if (this.next >= this.maxEvents) return null;
    if (this.next >= this.sentAt.length) this.grow();
    const no = this.next++;
    this.sentAt[no] = nowMs;
    this.state[no] = S.InFlight;
    this.stageOf[no] = st.index;
    st.attempted++;
    st.firstSendMs ??= nowMs;
    this.totalAttempted++;
    this.inFlight++;
    return no;
  }

  private stageFor(no: number): StageState | undefined {
    return this.stages[this.stageOf[no]];
  }

  ack(no: number, nowMs: number) {
    if (this.state[no] !== S.InFlight) return; // late duplicate callback: count once
    this.state[no] = S.Acked;
    this.inFlight--;
    const st = this.stageFor(no)!;
    const lat = nowMs - this.sentAt[no];
    st.acknowledged++;
    st.ackLat.push(lat);
    st.lastAckMs = Math.max(st.lastAckMs ?? 0, nowMs);
    // Pairs observed before the ack arrived become countable now that the event is acknowledged.
    const prior = popcount(this.seen[no]);
    st.observedPairs += prior;
    this.totalObservedPairs += prior;
    this.totalAcknowledged++;
    this.winAck++;
    this.winAckLat.push(lat);
  }

  fail(no: number, kind: "rejected" | "transport", reason: string) {
    if (this.state[no] !== S.InFlight) return;
    this.state[no] = kind === "rejected" ? S.Rejected : S.Transport;
    this.inFlight--;
    const st = this.stageFor(no)!;
    if (kind === "rejected") {
      st.rejected++;
      this.totalRejected++;
    } else {
      st.transport++;
      this.totalTransport++;
    }
    const key = `${kind}: ${reason}`.slice(0, 120);
    st.reasons.set(key, (st.reasons.get(key) ?? 0) + 1);
  }

  /** A subscriber received event `no` of this run through its subscription. */
  observe(subscriber: number, no: number, nowMs: number) {
    if (no >= this.next || this.state[no] === S.None) {
      this.unexpectedObservations++;
      return;
    }
    const bit = 1 << subscriber;
    const st = this.stageFor(no)!;
    if (this.seen[no] & bit) {
      st.duplicates++;
      return;
    }
    this.seen[no] |= bit;
    const lat = nowMs - this.sentAt[no];
    st.delLat.push(lat);
    this.winDelLat.push(lat);
    if (this.state[no] === S.Acked) {
      st.observedPairs++;
      this.totalObservedPairs++;
    }
  }

  /** Stop accepting sends for the current stage (drain begins). */
  closeSends(nowMs: number) {
    if (this.cur && this.cur.endEvent < 0) {
      this.cur.endEvent = this.next;
      this.cur.sendEndMs = nowMs;
    }
  }

  /** True when nothing is in flight and every acknowledged event reached every subscriber. */
  drained(activeSubscriberMask = this.fullMask): boolean {
    const st = this.cur;
    if (!st) return true;
    if (this.inFlight > 0) return false;
    const end = st.endEvent < 0 ? this.next : st.endEvent;
    for (let i = st.firstEvent; i < end; i++)
      if (this.state[i] === S.Acked && (this.seen[i] & activeSubscriberMask) !== activeSubscriberMask) return false;
    return true;
  }

  /** Close the current measurement window and return its sample. */
  window(nowMs: number, stageIndex: number): WindowSample {
    const windowMs = nowMs - this.winStart;
    const del = percentiles(this.winDelLat.values());
    const ack = percentiles(this.winAckLat.values());
    const sample: WindowSample = {
      stageIndex,
      elapsedMs: nowMs - this.runStartMs,
      windowMs,
      windowAcknowledged: this.winAck,
      achievedRate: ratePerSecond(this.winAck, windowMs),
      deliveryP95: del.p95,
      deliverySamples: del.samples,
      ackP95: ack.p95,
      totalAttempted: this.totalAttempted,
      totalAcknowledged: this.totalAcknowledged,
      totalRejected: this.totalRejected,
      totalTransportErrors: this.totalTransport,
      totalObservedPairs: this.totalObservedPairs,
      inFlight: this.inFlight,
    };
    this.winStart = nowMs;
    this.winAck = 0;
    this.winAckLat.clear();
    this.winDelLat.clear();
    return sample;
  }

  /**
   * End the current stage. `measuredSubscribers` is how many subscribers were live for the whole
   * stage; delivery success is only computed against those (a dead subscriber is reported, not hidden).
   */
  endStage(
    nowMs: number,
    opts: { notSentBackpressure: number; measuredSubscribers: number; eventLoopP99Ms: number | null; complete: boolean },
  ): StageResult {
    const st = this.cur;
    if (!st) throw new Error("no stage to end");
    this.closeSends(nowMs);
    this.cur = null;
    let observedWithoutAck = 0;
    for (let i = st.firstEvent; i < st.endEvent; i++)
      if (this.state[i] !== S.Acked && this.seen[i]) observedWithoutAck++;
    const unresolved = st.attempted - st.acknowledged - st.rejected - st.transport;
    const sendWindowMs = Math.max(st.sendEndMs! - st.startedMs, (st.lastAckMs ?? st.startedMs) - st.startedMs);
    return {
      stageIndex: st.index,
      roverCount: st.rovers,
      targetRate: st.targetRate,
      startedElapsedMs: st.startedMs - this.runStartMs,
      endedElapsedMs: nowMs - this.runStartMs,
      sendWindowMs,
      attempted: st.attempted,
      acknowledged: st.acknowledged,
      rejected: st.rejected,
      transportErrors: st.transport,
      unresolved,
      notSentBackpressure: opts.notSentBackpressure,
      observedPairs: Math.min(st.observedPairs, st.acknowledged * opts.measuredSubscribers),
      expectedPairs: st.acknowledged * opts.measuredSubscribers,
      duplicateObservations: st.duplicates,
      observedWithoutAck,
      achievedRate: st.acknowledged > 0 ? ratePerSecond(st.acknowledged, sendWindowMs) : null,
      ack: percentiles(st.ackLat.values()),
      delivery: percentiles(st.delLat.values()),
      eventLoopP99Ms: opts.eventLoopP99Ms,
      serverCommitted: null,
      serverFailed: null,
      rejectionReasons: Object.fromEntries(st.reasons),
      complete: opts.complete,
    };
  }
}

function popcount(v: number) {
  let c = 0;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  return c;
}

/** Delivery success as a fraction, or null when nothing was acknowledged (not measurable). */
export function deliverySuccess(r: Pick<StageResult, "observedPairs" | "expectedPairs">): number | null {
  return r.expectedPairs > 0 ? r.observedPairs / r.expectedPairs : null;
}
