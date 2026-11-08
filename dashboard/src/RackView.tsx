import { useEffect, useState, type ReactNode } from "react";
import { Timestamp } from "spacetimedb";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { DbConnection, tables } from "./module_bindings";
import type { Rack } from "./module_bindings/types";
import { metrics, date } from "./telemetry";
import { evaluate, validateObservation } from "../../spacetimedb/src/rules";
import InvestigationPanel from "./InvestigationPanel";
import Icon, { type IconName } from "./Icon";

export default function RackView({
  rack,
  online,
  rackSelection,
}: {
  rack: Rack;
  online: boolean;
  rackSelection: ReactNode;
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
  const [profiles, profilesReady] = useTable(tables.rackProfile);
  const [mode, setMode] = useState<"live" | "simulation">("live");
  const [freshness, setFreshness] = useState(60);
  const [now, setNow] = useState(Date.now());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [source, setSource] = useState("dashboard-demo");
  const [observedTime, setObservedTime] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const profile = profiles.find((p) => p.profileId === rack.profileId);
  const ready =
    online && currentReady && historyReady && alertsReady && profilesReady;
  const environmental = metrics.slice(0, 3);
  const active = alerts.filter(
    (a) =>
      a.active &&
      ["AMBIENT_TEMPERATURE_C", "RELATIVE_HUMIDITY_PERCENT"].includes(
        a.metricType,
      ),
  );
  const stale = (at: { microsSinceUnixEpoch: bigint }) =>
    now - Number(at.microsSinceUnixEpoch / 1000n) > freshness * 1000;
  const hasPhysical = current.some((r) => r.sourceType !== "SIMULATOR");
  const level = !online
    ? "unknown"
    : active.some((a) => a.severity === "CRITICAL")
      ? "critical"
      : active.length
        ? "warning"
        : "neutral";
  const complete = environmental.every((m) =>
    current.some((r) => r.metricType === m.id && !stale(r.observedAt)),
  );
  const rackStatus = !ready
    ? online
      ? "Synchronizing"
      : "Disconnected"
    : active.length
      ? "Issue detected"
      : complete
        ? "No threshold breach"
        : "Incomplete telemetry";
  const distance = current.find(
    (r) => r.metricType === "ULTRASONIC_DISTANCE_CM",
  );

  async function commit(action: (db: DbConnection) => Promise<void>) {
    const db = state.getConnection() as DbConnection | null;
    if (!db || !ready || pending) return;
    setPending(true);
    setFailed(false);
    setMessage("Waiting for backend acknowledgement…");
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
  function simulationControl(m: (typeof metrics)[number]): ReactNode {
    const reading = current.find((r) => r.metricType === m.id);
    const editable = !reading || reading.sourceType === "SIMULATOR";
    const value = drafts[m.id] ?? (reading ? String(reading.numericValue) : "");
    const sliderMax =
      m.id === "SOUND_RAW"
        ? Math.max(1000, Number(value) || 0)
        : m.id === "ULTRASONIC_DISTANCE_CM"
          ? Math.max(400, Number(value) || 0)
          : m.max;
    return (
      <form
        className="simulation-control"
        key={m.id}
        onSubmit={(e) => {
          e.preventDefault();
          if (!editable || drafts[m.id] === undefined || !value.trim()) return;
          const args = {
            rackId: rack.rackId,
            metricType: m.id,
            numericValue: Number(value),
            unit: m.unit,
            sourceType: "SIMULATOR",
            sourceIdentifier: source,
            observedAt: new Timestamp(
              BigInt(
                observedTime ? new Date(observedTime).getTime() : Date.now(),
              ) * 1000n,
            ),
          };
          void commit(async (db) => {
            validateObservation(
              { ...args, observedMicros: args.observedAt.microsSinceUnixEpoch },
              BigInt(Date.now()) * 1000n,
            );
            await db.reducers.ingestSimulatedObservation(args);
            setDrafts((old) => {
              const next = { ...old };
              delete next[m.id];
              return next;
            });
          });
        }}
      >
        <label htmlFor={`input-${m.id}`}>
          {m.label}
          <span>{m.unit}</span>
        </label>
        <div className="simulation-inputs">
          <input
            type="range"
            aria-label={`${m.label} slider`}
            min={m.min}
            max={sliderMax}
            step={m.step === "any" ? "1" : m.step}
            value={value || m.min}
            disabled={!editable || pending || !ready}
            onChange={(e) =>
              setDrafts((old) => ({ ...old, [m.id]: e.target.value }))
            }
          />
          <input
            id={`input-${m.id}`}
            aria-label={m.label}
            type="number"
            min={m.min}
            max={m.max}
            step={m.step}
            required
            placeholder="Set value"
            value={value}
            disabled={!editable || pending || !ready}
            onChange={(e) =>
              setDrafts((old) => ({ ...old, [m.id]: e.target.value }))
            }
          />
          <button
            disabled={
              !ready ||
              pending ||
              !editable ||
              drafts[m.id] === undefined ||
              !value.trim() ||
              !source.trim()
            }
            aria-label={`Apply ${m.label}`}
          >
            Apply
          </button>
        </div>
        {!editable && (
          <small className="warning-text">
            Physical-source reading protected. Simulation cannot overwrite it.
          </small>
        )}
      </form>
    );
  }
  const telemetry = (
    <>
      <section
        className="panel telemetry-card"
        aria-labelledby="telemetry-title"
      >
        <div className="panel-heading">
          <h2 id="telemetry-title">Live Telemetry</h2>
          <span className="source-tag">
            {current.length
              ? current.every((r) => r.sourceType === "SIMULATOR")
                ? "Simulated source"
                : current.some((r) => r.sourceType === "SIMULATOR")
                  ? "Mixed sources"
                  : "Live source"
              : "Awaiting data"}
          </span>
        </div>
        <div className="telemetry-rows">
          {environmental.map((m, i) => {
            const reading = current.find((r) => r.metricType === m.id);
            const violation =
              reading && profile
                ? evaluate(m.id, reading.numericValue, profile)
                : undefined;
            const old = reading && stale(reading.observedAt);
            return (
              <div
                className={`telemetry-row ${violation?.severity.toLowerCase() ?? ""}`}
                data-testid={m.id}
                key={m.id}
              >
                <span className="metric-icon">
                  <Icon
                    name={
                      (["temperature", "humidity", "sound"] as IconName[])[i]
                    }
                    size={23}
                  />
                </span>
                <div className="metric-label">
                  <h3>{["Temperature", "Humidity", "Sound"][i]}</h3>
                  <span>
                    {!online
                      ? "Disconnected"
                      : !currentReady
                        ? "Synchronizing"
                        : reading
                          ? `${reading.sourceType === "SIMULATOR" ? "Simulated" : "Live"} · ${old ? "Stale" : "Fresh"}`
                          : "No observation"}
                  </span>
                </div>
                <div
                  className={`metric-value ${!reading ? "unavailable" : ""}`}
                >
                  {reading
                    ? reading.numericValue.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })
                    : currentReady
                      ? "Unavailable"
                      : "Syncing…"}
                  {reading && <small>{m.unit}</small>}
                </div>
                {reading && (
                  <div className="reading-provenance">
                    <span>
                      {reading.sourceIdentifier} · {reading.sourceType}
                    </span>
                    <time title={`Ingested ${date(reading.ingestedAt)}`}>
                      Updated {date(reading.observedAt)}
                    </time>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="telemetry-bottom">
          <span>
            <span className={`status-dot ${online ? "" : "inactive"}`} />
            {online ? "Subscribed in real time" : "Connection unavailable"}
          </span>
          <label>
            Stale after
            <select
              aria-label="Freshness threshold"
              value={freshness}
              onChange={(e) => setFreshness(Number(e.target.value))}
            >
              <option value={30}>30 sec</option>
              <option value={60}>60 sec</option>
              <option value={300}>5 min</option>
            </select>
          </label>
        </div>
        <div className="telemetry-mode">
          <div className="segmented" aria-label="Telemetry mode">
            <button
              aria-pressed={mode === "live"}
              onClick={() => setMode("live")}
            >
              Live
            </button>
            <button
              aria-pressed={mode === "simulation"}
              onClick={() => setMode("simulation")}
            >
              Simulation
            </button>
          </div>
          <span>
            {mode === "live"
              ? "Read-only subscribed values"
              : "Explicit simulated writes"}
          </span>
        </div>
        {mode === "simulation" && (
          <div className="simulation-editor">
            <p className="muted">
              Adjust a value, then Apply. Missing readings stay unavailable
              until accepted by the backend. Sound is uncalibrated raw
              intensity.
            </p>
            {environmental.map(simulationControl)}
            <details className="advanced-settings">
              <summary>Source &amp; observation time</summary>
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
                  Observation time <small>blank = submit time</small>
                  <input
                    aria-label="Observation time"
                    type="datetime-local"
                    step="1"
                    value={observedTime}
                    onChange={(e) => setObservedTime(e.target.value)}
                  />
                </label>
              </div>
            </details>
          </div>
        )}
      </section>
      <section
        className="safety-strip"
        aria-label="Rover Safety"
        data-testid="rover-safety"
      >
        <span className="safety-icon">
          <Icon name="safety" size={23} />
        </span>
        <div>
          <h2>Rover Safety</h2>
          <p>
            {distance
              ? `${distance.sourceType === "SIMULATOR" ? "Simulated" : "Live"} distance · ${!online ? "Disconnected" : stale(distance.observedAt) ? "Stale" : "Fresh"}`
              : "Distance unavailable"}
          </p>
        </div>
        <div className="distance-value">
          {distance ? (
            <>
              {distance.numericValue.toLocaleString()} <small>cm</small>
            </>
          ) : (
            "—"
          )}
          <span>Controller not connected</span>
        </div>
        <p className="safety-note">
          Collision safety only. Controller thresholds and motion state are
          unavailable.
        </p>
        {mode === "simulation" && (
          <details className="safety-simulator">
            <summary>Simulate distance</summary>
            {simulationControl(metrics[3])}
          </details>
        )}
      </section>
      {message && (
        <div role="status" className={failed ? "error feedback" : "feedback"}>
          {message}
        </div>
      )}
    </>
  );
  return (
    <>
      <section
        className="selection-bar"
        aria-label="Selected rack configuration"
      >
        {rackSelection}
        <label className="server-select">
          <span>
            Server profile <small>simulation configuration</small>
          </span>
          <select
            aria-label="Server simulation profile"
            value={rack.profileId}
            disabled={!ready || pending || hasPhysical}
            onChange={(e) => {
              const profileId = e.target.value;
              void commit((db) =>
                db.reducers.changeRackProfile({
                  rackId: rack.rackId,
                  profileId,
                }),
              );
            }}
          >
            {profiles.map((p) => (
              <option key={p.profileId} value={p.profileId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="profile-limits">
          <span>Demo thresholds</span>
          <p>
            <b>{profile?.temperatureWarningC ?? "—"}°</b> warning <span>/</span>{" "}
            <b>{profile?.temperatureCriticalC ?? "—"}°</b> critical{" "}
            <span>·</span> <b>{profile?.humidityWarningPercent ?? "—"}%RH</b>{" "}
            warning
          </p>
          <small>
            Fictional settings · not manufacturer specifications or installed
            identity
          </small>
        </div>
        <div className={`rack-status ${level}`} data-testid="rack-status">
          <span className="status-dot" />
          <div>
            <small>Current rack status</small>
            <strong>{rackStatus}</strong>
          </div>
        </div>
      </section>
      <InvestigationPanel
        rack={rack}
        profile={profile}
        current={current}
        history={history}
        alerts={alerts}
        ready={ready}
        freshnessSeconds={freshness}
        telemetry={telemetry}
      />
      <details className="panel observation-details">
        <summary>
          <span>Observation history &amp; alerts</span>
          <small>
            {history.length} recent observations · {active.length} active alerts
          </small>
          <Icon name="chevron" size={16} />
        </summary>
        <div className="alerts">
          <h3>Active environmental alerts</h3>
          {!active.length ? (
            <p className="muted">
              No active threshold alerts. Missing or stale measurements do not
              establish equipment health.
            </p>
          ) : (
            active.map((a) => (
              <article
                className={`alert-item ${a.severity.toLowerCase()}`}
                key={a.alertId}
              >
                <span className="severity">{a.severity}</span>
                <p>{a.message}</p>
                <time>{date(a.createdAt)}</time>
              </article>
            ))
          )}
        </div>
        <section className="history">
          <h3>Recent history</h3>
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
                  .sort((a, b) =>
                    a.ingestedAt.microsSinceUnixEpoch >
                    b.ingestedAt.microsSinceUnixEpoch
                      ? -1
                      : a.ingestedAt.microsSinceUnixEpoch <
                          b.ingestedAt.microsSinceUnixEpoch
                        ? 1
                        : a.observationId > b.observationId
                          ? -1
                          : 1,
                  )
                  .map((o) => (
                    <tr key={o.observationId.toString()}>
                      <td>
                        {metrics.find((m) => m.id === o.metricType)?.label ??
                          o.metricType}
                        {o.metricType === "ULTRASONIC_DISTANCE_CM" && (
                          <small>Collision safety only</small>
                        )}
                      </td>
                      <td className="reading-cell">
                        {o.numericValue} {o.unit}
                      </td>
                      <td>
                        <span className="source-tag">{o.sourceType}</span>
                        <small>{o.sourceIdentifier}</small>
                      </td>
                      <td>{date(o.observedAt)}</td>
                      <td>{date(o.ingestedAt)}</td>
                    </tr>
                  ))}
                {!history.length && (
                  <tr>
                    <td colSpan={5} className="empty-history">
                      No observations received.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="quiet-note">
            Latest 50 observations per rack. Full history remains in
            SpacetimeDB.
          </p>
        </section>
      </details>
    </>
  );
}
