import { useEffect, useState } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables } from "./module_bindings";
import RackView from "./RackView";
export default function App() {
  const state = useSpacetimeDB();
  const [racks, racksReady] = useTable(tables.rack);
  const [profiles] = useTable(tables.rackProfile);
  const [selected, setSelected] = useState("rack-1");
  const [wasConnected, setWasConnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  useEffect(() => {
    if (state.isActive) {
      setWasConnected(true);
      setReconnectKey((k) => k + 1);
    }
  }, [state.isActive]);
  const rack = racks.find((r) => r.rackId === selected);
  const profile = profiles.find((p) => p.profileId === rack?.profileId);
  const status = state.connectionError
    ? "Error"
    : state.isActive
      ? "Connected"
      : wasConnected
        ? "Disconnected"
        : "Connecting";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Sentinel home">
          <span className="brand-mark">S</span>SENTINEL
          <span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">OPERATIONS WORKSPACE</div>
        <div className="nav-active">
          <span>▦</span> Telemetry overview
        </div>
        <div className="sidebar-line" />
        <div className="workspace-label">
          MONITORED RACKS{" "}
          <span>{racks.length.toString().padStart(2, "0")}</span>
        </div>
        <nav aria-label="Rack selector">
          {[...racks]
            .sort((a, b) => a.rackId.localeCompare(b.rackId))
            .map((r) => (
              <button
                className={`rack-link ${r.rackId === selected ? "selected" : ""}`}
                key={r.rackId}
                onClick={() => setSelected(r.rackId)}
              >
                <span className="rack-icon">▤</span>
                <span>
                  {r.displayName}
                  <small>
                    {
                      profiles.find((p) => p.profileId === r.profileId)
                        ?.equipmentType
                    }
                  </small>
                </span>
                <span className="rack-arrow">›</span>
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="small-square" /> LOCAL DEMONSTRATION
          <small>SpacetimeDB · Feature 01</small>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumbs">
            SENTINEL <span>/</span> Infrastructure <span>/</span> Telemetry
          </div>
          <div
            className={`connection ${state.isActive ? "online" : "offline"}`}
            role="status"
          >
            <i />
            {status}
          </div>
        </header>
        <section className="page-heading">
          <div>
            <div className="eyebrow">INFRASTRUCTURE OBSERVABILITY</div>
            <h1>Telemetry overview</h1>
            <p>Real-time environmental visibility. Every reading, traceable.</p>
          </div>
          <span className="demo-badge">SIMULATION ENVIRONMENT</span>
        </section>
        {state.connectionError && (
          <div className="error" role="alert">
            {state.connectionError.message}
          </div>
        )}
        <section className="rack-summary">
          <div>
            <span className="eyebrow">SELECTED RACK</span>
            <h2>
              {rack?.displayName ||
                (racksReady ? "No rack configured" : "Connecting to database…")}
            </h2>
            <p>{rack?.locationLabel || "Awaiting SpacetimeDB subscription"}</p>
          </div>
          <div>
            <span className="eyebrow">EQUIPMENT / PROFILE</span>
            <strong>{profile?.equipmentType || "—"}</strong>
            <p>{profile?.name || "—"}</p>
          </div>
          <div className="thresholds">
            <span className="eyebrow">DEMONSTRATION THRESHOLDS</span>
            <p>
              Temperature <b>{profile?.temperatureWarningC ?? "—"}° warning</b>{" "}
              /{" "}
              <b className="critical-text">
                {profile?.temperatureCriticalC ?? "—"}° critical
              </b>
            </p>
            <p>
              Humidity{" "}
              <b>{profile?.humidityWarningPercent ?? "—"}%RH warning</b>
            </p>
          </div>
        </section>
        <p className="config-note">
          Fictional demonstration thresholds · Not verified manufacturer
          specifications
        </p>
        {rack && (
          <RackView
            key={`${rack.rackId}:${reconnectKey}`}
            rack={rack}
            online={state.isActive}
          />
        )}
        <footer>
          <span>SENTINEL / TELEMETRY FOUNDATION</span>
          <span>Transactional writes · Live subscriptions · No polling</span>
        </footer>
      </main>
    </div>
  );
}
