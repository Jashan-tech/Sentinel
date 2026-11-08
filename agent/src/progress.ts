// Live investigation progress (part 3 of the latency work): turns the engine's timeline events into a
// small, human-readable progress snapshot that is written to SpacetimeDB while the run is in flight,
// so every connected dashboard can show which agent is working. Purely descriptive: it reports what
// the engine has done, never what it will conclude.
import type { InvestigationEvent } from "./schemas.js";

export type StepState = "running" | "done" | "failed";
export interface ProgressStep {
  agent: string;
  state: StepState;
  started_at: string;
  ended_at?: string;
  tool_calls: number;
}
export interface ProgressSnapshot {
  phase: string;
  steps: ProgressStep[];
}

const LABEL: Record<string, string> = {
  supervisor: "Supervisor",
  telemetry: "Telemetry agent",
  environment: "Environment agent",
  documentation: "Documentation agent",
  vision: "Vision agent",
  verification: "Verification agent",
};
const label = (a: string) => LABEL[a] ?? a;

const DOING: Record<string, string> = {
  telemetry: "is checking current readings, trends and thresholds",
  environment: "is reviewing environmental history",
  documentation: "is looking up rack profile and equipment documentation",
  vision: "is inspecting the photo",
  verification: "is cross-checking the findings against the evidence",
};

export class ProgressTracker {
  private steps: ProgressStep[] = [];
  phase = "Supervisor is planning the investigation";

  private current(agent: string) {
    for (let i = this.steps.length - 1; i >= 0; i--) if (this.steps[i].agent === agent) return this.steps[i];
    return undefined;
  }

  /** Feed one engine event. Returns true when the snapshot changed in a way worth publishing now. */
  update(e: InvestigationEvent): boolean {
    const agent = e.agent ?? "";
    const d = e.description;
    if (e.type === "AGENT" && agent && / agent started/.test(d)) {
      this.steps.push({ agent, state: "running", started_at: e.timestamp, tool_calls: 0 });
      this.phase = `${label(agent)} ${DOING[agent] ?? "is working"}`;
      return true;
    }
    if ((e.type === "AGENT" || e.type === "ERROR") && agent && / agent (completed|incomplete|failed|output invalid|model call failed)/.test(d)) {
      const s = this.current(agent);
      if (s && s.state === "running") {
        s.state = e.status === "ERROR" || /failed|invalid/.test(d) ? "failed" : "done";
        s.ended_at = e.timestamp;
      }
      this.phase = "Supervisor is deciding the next step";
      return true;
    }
    if (e.type === "VERIFY") {
      const s = this.current("verification");
      if (s && s.state === "running") {
        s.state = "done";
        s.ended_at = e.timestamp;
      }
      this.phase = "Supervisor is deciding the next step";
      return true;
    }
    if (e.type === "TOOL" && agent) {
      const s = this.current(agent);
      if (s) s.tool_calls++;
      return false; // frequent; published with the next milestone or the throttle
    }
    if (e.type === "SUPERVISOR" && /^Decided to finish/.test(d)) {
      this.phase = "Supervisor is writing the final report";
      return true;
    }
    if (e.type === "SUPERVISOR" && /^Delegated to (\w+)/.test(d)) {
      const to = /^Delegated to (\w+)/.exec(d)![1];
      this.phase = `Supervisor assigned the ${label(to).toLowerCase()}`;
      return true;
    }
    if (e.type === "REPORT") {
      this.phase = "Recording the report";
      return true;
    }
    return false;
  }

  snapshot(): ProgressSnapshot {
    return { phase: this.phase, steps: this.steps.map((s) => ({ ...s })) };
  }
}

/**
 * Publishes progress snapshots through `send` without ever blocking the investigation:
 * milestones are sent immediately (one request in flight at a time, latest snapshot wins),
 * and failures are swallowed — progress is a convenience, the final report is the record.
 */
export function createProgressPublisher(send: (s: ProgressSnapshot) => Promise<void>, log: (m: string) => void = () => {}) {
  const tracker = new ProgressTracker();
  let inFlight = false;
  let pending: ProgressSnapshot | null = null;
  let failures = 0;
  const flush = async () => {
    if (inFlight || !pending) return;
    inFlight = true;
    const s = pending;
    pending = null;
    try {
      await send(s);
    } catch (err) {
      if (failures++ === 0) log(`progress update failed (further failures not logged): ${(err as Error).message}`);
    } finally {
      inFlight = false;
      if (pending) void flush();
    }
  };
  return {
    onEvent(e: InvestigationEvent) {
      if (tracker.update(e)) {
        pending = tracker.snapshot();
        void flush();
      }
    },
    /** Resolves once nothing is in flight (used by tests). */
    async idle() {
      while (inFlight || pending) await new Promise((r) => setTimeout(r, 5));
    },
    tracker,
  };
}
