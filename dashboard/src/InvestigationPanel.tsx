import { useMemo, useState } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { DbConnection, tables } from "./module_bindings";
import type { Rack, RackProfile, CurrentTelemetry, RecentObservation, RackAlert, Investigation } from "./module_bindings/types";
import { buildInvestigationRequest, validateInvestigationResponse, type AgentEvent, type AgentReport } from "./investigation";
import { date } from "./telemetry";

const AGENT_URL = "/api/agent/investigate"; // Vite proxy -> agent service (port 3001); no API key in the browser
const CLIENT_TIMEOUT_MS = 150_000; // agent budget is 90 s plus synthesis
const ABANDONED_AFTER_MS = 5 * 60_000; // RUNNING rows older than this no longer block new runs

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const micros = (r: Investigation) => r.createdAt.microsSinceUnixEpoch;

export default function InvestigationPanel(props: {
  rack: Rack;
  profile: RackProfile | undefined;
  current: readonly CurrentTelemetry[];
  history: readonly RecentObservation[];
  alerts: readonly RackAlert[];
  ready: boolean;
  freshnessSeconds: number;
}) {
  const { rack, profile, ready } = props;
  const state = useSpacetimeDB();
  const [rows, rowsReady] = useTable(tables.investigation.where((r) => r.rackId.eq(rack.rackId)));
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sorted = useMemo(() => [...rows].sort((a, b) => (micros(b) > micros(a) ? 1 : micros(b) < micros(a) ? -1 : 0)), [rows]);
  const shown = sorted.find((r) => r.investigationId === selectedId) ?? sorted[0];
  const runningElsewhere = sorted.some(
    (r) => r.status === "RUNNING" && Date.now() - Number(micros(r) / 1000n) < ABANDONED_AFTER_MS,
  );

  async function run() {
    if (busy || runningElsewhere) return; // duplicate-request guard (local + any session)
    const db = state.getConnection() as DbConnection | null;
    if (!db || !ready || !rowsReady || !profile) {
      setLocalError("Subscriptions are not synchronized yet.");
      return;
    }
    setBusy(true);
    setLocalError("");
    // One logical snapshot of the subscribed rows for this rack, captured at click time.
    const request = buildInvestigationRequest({
      rack,
      profile,
      current: props.current,
      recent: props.history,
      alerts: props.alerts,
      asOf: new Date(),
      staleAfterSeconds: props.freshnessSeconds,
    });
    const investigationId = crypto.randomUUID();
    try {
      await db.reducers.startInvestigation({ investigationId, rackId: rack.rackId, snapshotJson: JSON.stringify(request) });
    } catch (e) {
      setLocalError(`Could not record the investigation in SpacetimeDB: ${(e as Error).message}`);
      setBusy(false);
      return;
    }
    setSelectedId(investigationId);

    let status = "FAILED";
    let severity = "UNKNOWN";
    let reportJson = "";
    let eventsJson = "[]";
    try {
      const res = await fetch(AGENT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => null);
      if (!body?.report) throw new Error(body?.message ?? body?.error ?? `Agent service returned HTTP ${res.status}`);
      const { report, events } = validateInvestigationResponse(body, rack.rackId);
      status = report.investigation_status;
      severity = report.severity;
      reportJson = JSON.stringify(report);
      eventsJson = JSON.stringify(events);
    } catch (e) {
      const err = e as Error;
      const message =
        err.name === "TimeoutError"
          ? `Agent did not respond within ${CLIENT_TIMEOUT_MS / 1000} s`
          : err.message.includes("Failed to fetch")
            ? "Agent service is unreachable (is it running on port 3001?)"
            : err.message;
      reportJson = JSON.stringify({ error: message });
      setLocalError(message);
    }
    try {
      await db.reducers.completeInvestigation({ investigationId, status, severity, reportJson, eventsJson });
    } catch (e) {
      setLocalError(`Investigation finished but could not be saved: ${(e as Error).message}`);
    }
    setBusy(false);
  }

  const report = shown && shown.status !== "RUNNING" ? parse<Partial<AgentReport> & { error?: string }>(shown.reportJson, {}) : null;
  const events = shown ? parse<AgentEvent[]>(shown.eventsJson, []) : [];
  const abandoned = shown?.status === "RUNNING" && Date.now() - Number(micros(shown) / 1000n) >= ABANDONED_AFTER_MS;

  return (
    <section className="panel investigation" data-testid="investigation-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">NVIDIA NEMOTRON · MULTI-AGENT</span>
          <h2>AI investigation</h2>
        </div>
        <button
          className="investigate-button"
          onClick={() => void run()}
          disabled={!ready || !rowsReady || busy || runningElsewhere}
        >
          {busy || runningElsewhere ? "Investigation running…" : "Run AI Investigation"}
        </button>
      </div>
      <p className="muted">
        Runs only when requested. A Supervisor agent delegates to Telemetry, Environment, Documentation and Verification
        agents using this rack's subscribed data. AI output is hypotheses, not confirmed faults.
      </p>
      {localError && (
        <div className="error" role="alert">
          {localError}
        </div>
      )}
      {sorted.length > 1 && (
        <label className="inv-history">
          History{" "}
          <select value={shown?.investigationId} onChange={(e) => setSelectedId(e.target.value)} aria-label="Investigation history">
            {sorted.map((r) => (
              <option key={r.investigationId} value={r.investigationId}>
                {date(r.createdAt)} · {r.status} · {r.severity} · {r.profileName}
              </option>
            ))}
          </select>
        </label>
      )}

      {!rowsReady ? (
        <p className="muted">Synchronizing investigations…</p>
      ) : !shown ? (
        <p className="muted">No investigations for this rack yet.</p>
      ) : (
        <div className="inv-body" data-testid="investigation-record" data-id={shown.investigationId} data-status={shown.status} data-severity={shown.severity}>
          <div className="inv-status-row">
            <span className={`inv-badge status-${shown.status.toLowerCase()}`}>{abandoned ? "ABANDONED" : shown.status}</span>
            {shown.status !== "RUNNING" && <span className={`inv-badge sev-${shown.severity.toLowerCase()}`}>{shown.severity}</span>}
            {shown.telemetrySimulated && <span className="sim-label">SIMULATED TELEMETRY</span>}
            <span className="inv-meta">
              Profile at run: {shown.profileName} · Started {date(shown.createdAt)}
              {shown.completedAt ? ` · Finished ${date(shown.completedAt)}` : ""}
            </span>
          </div>

          {shown.status === "RUNNING" && !abandoned && <p className="inv-running">Agents are investigating… results will appear here for every connected session.</p>}
          {abandoned && <p className="error">No completion was recorded for this investigation. Treat it as failed.</p>}
          {shown.status === "FAILED" && (
            <p className="error">Investigation failed. No diagnosis was produced. {report?.error ?? report?.summary ?? ""}</p>
          )}
          {shown.status === "INCOMPLETE" && (
            <p className="inv-warning">
              Incomplete investigation{report?.limits_reached?.length ? ` (limits reached: ${report.limits_reached.join(", ")})` : ""}. Treat
              the diagnosis as partial.
            </p>
          )}

          {report && report.summary && shown.status !== "FAILED" && (
            <>
              <h3 className="inv-h">Final diagnosis <small>AI-written summary</small></h3>
              <p className="inv-summary">{report.summary}</p>

              <div className="inv-grid">
                <div>
                  <h3 className="inv-h">Measured facts <small>from tool output, not AI-written</small></h3>
                  <ul className="inv-list facts">
                    {(report.evidence?.measurements ?? []).map((m, i) => (
                      <li key={i}>
                        <b>{String(m.metric_type)}</b> {String(m.numeric_value)} {String(m.unit)}{" "}
                        <small>
                          {String(m.source_type)} · {String(m.source_identifier)} · {String(m.observed_at)}
                          {m.stale ? " · STALE" : ""}
                        </small>
                      </li>
                    ))}
                    {!report.evidence?.measurements?.length && <li className="muted-item">No current readings were retrieved.</li>}
                    {report.evidence?.configured_thresholds && (
                      <li>
                        <b>Thresholds</b> warn {String(report.evidence.configured_thresholds.temperature_warning_c)} / crit{" "}
                        {String(report.evidence.configured_thresholds.temperature_critical_c)} °C{" "}
                        <small>fictional demo configuration</small>
                      </li>
                    )}
                  </ul>
                </div>
                <div>
                  <h3 className="inv-h">AI hypotheses <small>not confirmed faults</small></h3>
                  <ul className="inv-list">
                    {(report.hypotheses ?? []).map((h, i) => (
                      <li key={i}>
                        {h.description}
                        {h.supporting_evidence.map((e, j) => <div key={`s${j}`} className="ev plus">+ {e}</div>)}
                        {h.contradicting_evidence.map((e, j) => <div key={`c${j}`} className="ev minus">− {e}</div>)}
                        {h.missing_evidence.map((e, j) => <div key={`m${j}`} className="ev missing">? {e}</div>)}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="inv-grid">
                <div>
                  <h3 className="inv-h">
                    Verification{" "}
                    <small>
                      {report.verification ? (report.verification.grounded ? "findings grounded" : "grounding problems found") : "not run"}
                    </small>
                  </h3>
                  <ul className="inv-list">
                    {(report.verified_findings ?? []).map((f, i) => <li key={`v${i}`}>✓ {f}</li>)}
                    {(report.verification?.unsupported_claims ?? []).map((f, i) => <li key={`u${i}`} className="ev minus">Unsupported: {f}</li>)}
                    {(report.verification?.contradictions ?? []).map((f, i) => <li key={`x${i}`} className="ev minus">Contradiction: {f}</li>)}
                    {report.verification?.request_more_investigation && (
                      <li className="ev missing">
                        Requested follow-up: {report.verification.follow_up_agent} — {report.verification.follow_up_objective}
                      </li>
                    )}
                  </ul>
                </div>
                <div>
                  <h3 className="inv-h">Missing evidence</h3>
                  <ul className="inv-list">
                    {(report.missing_information ?? []).map((f, i) => <li key={i} className="ev missing">{f}</li>)}
                  </ul>
                  <h3 className="inv-h">Recommended next inspection</h3>
                  <ul className="inv-list">
                    {(report.recommended_next_inspection ?? []).map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              </div>

              <details className="inv-details">
                <summary>
                  Supervisor plan &amp; agents: {(report.agents_invoked ?? []).map((a) => a.agent).join(" → ") || "none"}
                </summary>
                <p className="inv-plan">{report.supervisor_plan}</p>
                {(report.specialist_findings ?? []).map((f, i) => (
                  <div key={i} className="inv-finding">
                    <b>{f.agent.toUpperCase()}</b> <small>[{f.status}] {f.objective}</small>
                    <ul className="inv-list">
                      {f.observations.map((o, j) => <li key={j}>{o}</li>)}
                    </ul>
                  </div>
                ))}
                <small className="inv-meta">Model: {report.model}</small>
              </details>
            </>
          )}

          {events.length > 0 && (
            <details className="inv-details">
              <summary>Execution timeline ({events.length} events, recorded during the run)</summary>
              <ol className="inv-timeline">
                {events.map((e, i) => (
                  <li key={i} className={e.status === "ERROR" ? "ev minus" : ""}>
                    <code>{e.type}</code> {e.description}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
      <div className="alert-note">
        Local demo trust model: investigation records are submitted by the dashboard client and validated for shape and
        consistency by SpacetimeDB; they are not cryptographically attested as agent output.
      </div>
    </section>
  );
}
