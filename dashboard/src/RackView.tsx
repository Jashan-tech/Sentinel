import { useEffect, useState } from "react";
import { Timestamp } from "spacetimedb";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { DbConnection, tables } from "./module_bindings";
import type { Rack } from "./module_bindings/types";
import { metrics, date } from "./telemetry";
import InvestigationPanel from "./InvestigationPanel";
export default function RackView({
  rack,
  online,
}: {
  rack: Rack;
  online: boolean;
}) {
  const state = useSpacetimeDB();
  const [current, currentReady] = useTable(
    tables.currentTelemetry.where((r) => r.rackId.eq(rack.rackId)),
  );
  const [history, historyReady] = useTable(
    tables.recentObservation.where((r) => r.rackId.eq(rack.rackId)),
  );
  const [alerts, alertsReady] = useTable(
    tables.rackAlert.where((r) => r.rackId.eq(rack.rackId)),
  );
  const [profiles] = useTable(tables.rackProfile);
  const [freshness, setFreshness] = useState(60);
  const [now, setNow] = useState(Date.now());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [source, setSource] = useState("dashboard-demo");
  const [observedTime, setObservedTime] = useState("");
  const [profileDraft, setProfileDraft] = useState(rack.profileId);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []); // Local age display only; no network reads.
  useEffect(() => setProfileDraft(rack.profileId), [rack.profileId]);
  async function commit(action: (db: DbConnection) => Promise<void>) {
    const db = state.getConnection() as DbConnection | null;
    if (!db || !online) return;
    setPending(true);
    setMessage("Waiting for backend acknowledgement…");
    setFailed(false);
    try {
      await action(db);
      setMessage("Committed by SpacetimeDB.");
    } catch (e) {
      setFailed(true);
      setMessage((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  const active = alerts.filter((a) => a.active);
  const ready = online && currentReady && historyReady && alertsReady;
  return (
    <>
      <div className="section-heading">
        <h2>
          Live telemetry{" "}
          <span className="live-tag">{online ? "● LIVE" : "○ OFFLINE"}</span>
        </h2>
        <label className="freshness-setting">
          Stale after{" "}
          <select
            aria-label="Freshness threshold"
            value={freshness}
            onChange={(e) => setFreshness(Number(e.target.value))}
          >
            <option value={30}>30 seconds</option>
            <option value={60}>60 seconds</option>
            <option value={300}>5 minutes</option>
          </select>
        </label>
      </div>
      <div className="metrics">
        {metrics.map((m) => {
          const reading = current.find((c) => c.metricType === m.id);
          const stale =
            reading &&
            now - Number(reading.observedAt.microsSinceUnixEpoch / 1000n) >
              freshness * 1000;
          return (
            <article className="metric-card" key={m.id} data-testid={m.id}>
              <div className="metric-top">
                <span className="metric-glyph">{m.glyph}</span>
                <span
                  className={`fresh-badge ${!online || stale ? "stale" : reading ? "fresh" : ""}`}
                >
                  {!online
                    ? "Offline"
                    : !currentReady
                      ? "Syncing"
                      : reading
                        ? stale
                          ? "Stale"
                          : "Fresh"
                        : "No data"}
                </span>
              </div>
              <h3>{m.label}</h3>
              <div className={`metric-value ${!reading ? "unavailable" : ""}`}>
                {reading
                  ? reading.numericValue.toLocaleString(undefined, {
                      maximumFractionDigits: 3,
                    })
                  : currentReady
                    ? "Unavailable"
                    : "Syncing…"}
                {reading && <span>{m.unit}</span>}
              </div>
              <div className="metric-meta">
                {reading ? (
                  <>
                    <span className="sim-label">{reading.sourceType}</span>
                    <span>{reading.sourceIdentifier}</span>
                    <small>Observed {date(reading.observedAt)}</small>
                    <small>Ingested {date(reading.ingestedAt)}</small>
                  </>
                ) : (
                  <p>Awaiting an explicit simulated observation</p>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <div className="work-grid">
        <section className="panel simulator">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DEMONSTRATION WRITE PATH</span>
              <h2>Submit a simulated reading</h2>
            </div>
            <span className="outline-tag">SIMULATOR</span>
          </div>
          <p className="muted">
            One measurement per submission. Values are never generated
            automatically.
          </p>
          <div className="source-fields">
            <label>
              Source identifier
              <input
                aria-label="Source identifier"
                value={source}
                maxLength={100}
                required
                onChange={(e) => setSource(e.target.value)}
              />
            </label>
            <label>
              Observation time <small>(blank = submit time)</small>
              <input
                aria-label="Observation time"
                type="datetime-local"
                step="1"
                value={observedTime}
                onChange={(e) => setObservedTime(e.target.value)}
              />
            </label>
          </div>
          {metrics.map((m) => (
            <form
              className="metric-input-row"
              key={m.id}
              onSubmit={(e) => {
                e.preventDefault();
                void commit((db) =>
                  db.reducers.ingestSimulatedObservation({
                    rackId: rack.rackId,
                    metricType: m.id,
                    numericValue: Number(drafts[m.id]),
                    unit: m.unit,
                    sourceType: "SIMULATOR",
                    sourceIdentifier: source,
                    observedAt: new Timestamp(
                      BigInt(
                        observedTime
                          ? new Date(observedTime).getTime()
                          : Date.now(),
                      ) * 1000n,
                    ),
                  }),
                );
              }}
            >
              <label htmlFor={`input-${m.id}`}>
                {m.label}
                <small>
                  {m.id === "SOUND_RAW"
                    ? "Raw sensor value · Not calibrated dB"
                    : m.id === "ULTRASONIC_DISTANCE_CM"
                      ? "HC-SR04 compatible measurement"
                      : "Rover-compatible environmental measurement"}
                </small>
              </label>
              <div className="value-input">
                <input
                  aria-label={m.label}
                  id={`input-${m.id}`}
                  type="number"
                  min={m.min}
                  max={m.max}
                  step={m.step}
                  placeholder="—"
                  required
                  value={drafts[m.id] ?? ""}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [m.id]: e.target.value })
                  }
                />
                <span>{m.unit}</span>
              </div>
              <button disabled={!ready || pending || !source.trim()}>
                Submit
              </button>
            </form>
          ))}
          <form
            className="profile-form"
            onSubmit={(e) => {
              e.preventDefault();
              void commit((db) =>
                db.reducers.changeRackProfile({
                  rackId: rack.rackId,
                  profileId: profileDraft,
                }),
              );
            }}
          >
            <label>
              Selected rack profile
              <select
                aria-label="Selected rack profile"
                value={profileDraft}
                onChange={(e) => setProfileDraft(e.target.value)}
              >
                {profiles.map((p) => (
                  <option key={p.profileId} value={p.profileId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!ready || pending || profileDraft === rack.profileId}
            >
              Apply profile
            </button>
          </form>
          <div role="status" className={failed ? "error feedback" : "feedback"}>
            {message || "Writes require a connected backend."}
          </div>
        </section>
        <section className="panel alerts">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DETERMINISTIC MONITORING</span>
              <h2>Active alerts</h2>
            </div>
            <span className="count">
              {active.length.toString().padStart(2, "0")}
            </span>
          </div>
          <p className="muted">Threshold rules evaluated inside SpacetimeDB.</p>
          {!alertsReady ? (
            <p>Synchronizing alerts…</p>
          ) : !active.length ? (
            <div className="empty-alert">
              <span>◇</span>
              <h3>No active threshold alerts</h3>
              <p>
                Missing or stale readings do not establish equipment health.
              </p>
            </div>
          ) : (
            active.map((a) => (
              <article
                className={`alert-item ${a.severity.toLowerCase()}`}
                key={a.alertId}
              >
                <div>
                  <span className="severity">{a.severity}</span>
                  <span>
                    {metrics.find((m) => m.id === a.metricType)?.label}
                  </span>
                </div>
                <p>{a.message}</p>
                <time>{date(a.createdAt)}</time>
              </article>
            ))
          )}
          <div className="alert-note">
            Monitoring rules only. No AI diagnosis or repair recommendations.
          </div>
        </section>
      </div>
      <InvestigationPanel
        rack={rack}
        profile={profiles.find((p) => p.profileId === rack.profileId)}
        current={current}
        history={history}
        alerts={alerts}
        ready={ready}
        freshnessSeconds={freshness}
      />
      <section className="panel history">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">OBSERVATION LOG</span>
            <h2>Recent history</h2>
          </div>
          <span className="outline-tag">LATEST 50 / RACK</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Measurement</th>
                <th>Value</th>
                <th>Source</th>
                <th>Observed</th>
                <th>Ingested</th>
              </tr>
            </thead>
            <tbody>
              {[...history]
                .sort((a, b) => {
                  const d =
                    b.ingestedAt.microsSinceUnixEpoch -
                    a.ingestedAt.microsSinceUnixEpoch;
                  return d > 0n
                    ? 1
                    : d < 0n
                      ? -1
                      : a.observationId > b.observationId
                        ? -1
                        : 1;
                })
                .map((o) => (
                  <tr key={o.observationId.toString()}>
                    <td>{metrics.find((m) => m.id === o.metricType)?.label}</td>
                    <td className="reading-cell">
                      {o.numericValue} <span>{o.unit}</span>
                    </td>
                    <td>
                      <span className="sim-label">SIMULATOR</span>
                      <small>{o.sourceIdentifier}</small>
                    </td>
                    <td>{date(o.observedAt)}</td>
                    <td>{date(o.ingestedAt)}</td>
                  </tr>
                ))}
              {!history.length && (
                <tr>
                  <td className="empty-history" colSpan={5}>
                    {historyReady
                      ? "No observations yet. Submit a simulated reading to begin."
                      : "Synchronizing observation history…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="history-note">
          Full immutable history remains in SpacetimeDB. This view is bounded by
          ingestion order.
        </p>
      </section>
    </>
  );
}
