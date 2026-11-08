import { useEffect, useState } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables } from "./module_bindings";
import RackView from "./RackView";
import FleetSimulation from "./FleetSimulation";
import Icon from "./Icon";
import { catalogEntry } from "../../spacetimedb/src/equipmentCatalog";

export default function App() {
  const state = useSpacetimeDB();
  const [racks, racksReady] = useTable(tables.rack);
  const [alerts] = useTable(tables.rackAlert);
  const [selected, setSelected] = useState("rack-1");
  const [page, setPage] = useState<"rack" | "fleet">("rack");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [wasConnected, setWasConnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  useEffect(() => {
    if (state.isActive) {
      setWasConnected(true);
      setReconnectKey((k) => k + 1);
    }
  }, [state.isActive]);
  const issues = new Set(
    alerts
      .filter(
        (a) =>
          a.active &&
          ["AMBIENT_TEMPERATURE_C", "RELATIVE_HUMIDITY_PERCENT"].includes(
            a.metricType,
          ),
      )
      .map((a) => a.rackId),
  );
  const visible = [...racks]
    .filter((r) => !issuesOnly || issues.has(r.rackId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const visibleKey = visible.map((r) => r.rackId).join("|");
  useEffect(() => {
    if (
      racksReady &&
      visible.length &&
      !visible.some((r) => r.rackId === selected)
    )
      setSelected(visible[0].rackId);
  }, [racksReady, selected, visibleKey]);
  const rack = visible.find((r) => r.rackId === selected);
  const status = state.connectionError
    ? "Error"
    : state.isActive
      ? "Connected"
      : wasConnected
        ? "Disconnected"
        : "Connecting";
  const [equipment] = useTable(tables.rackEquipment);
  const serverName = (rackId: string) => {
    const e = catalogEntry(equipment.find((x) => x.rackId === rackId)?.modelId ?? "");
    return e ? `${e.manufacturer} ${e.model}` : "No server selected";
  };
  const rackSelection = (
    <div className="rack-nav">
      <div className="rack-nav-head">
        <span className="sidebar-label">Racks</span>
        <label className="issues-filter">
          <input
            type="checkbox"
            checked={issuesOnly}
            onChange={(e) => setIssuesOnly(e.target.checked)}
          />
          Issues only
        </label>
      </div>
      <div className="rack-list" role="group" aria-label="Rack selector">
        {!visible.length && (
          <p className="rack-empty">
            {racksReady ? (issuesOnly ? "No racks with issues" : "No racks configured") : "Connecting…"}
          </p>
        )}
        {visible.map((r) => (
          <button
            key={r.rackId}
            type="button"
            className="rack-option"
            data-testid={`rack-option-${r.rackId}`}
            aria-current={r.rackId === rack?.rackId ? "true" : undefined}
            onClick={() => setSelected(r.rackId)}
          >
            <span className={`rack-dot ${issues.has(r.rackId) ? "issue" : "ok"}`} aria-hidden="true" />
            <span className="rack-option-text">
              <strong>{r.displayName}</strong>
              <small>{serverName(r.rackId)}</small>
            </span>
            {issues.has(r.rackId) && <span className="visually-hidden"> (issue)</span>}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="app-shell console">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="SENTINEL navigation">
        <div className="sidebar-top">
          <a
            className="brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setPage("rack");
            }}
            aria-label="SENTINEL home"
          >
            <span className="brand-mark">
              <svg viewBox="0 0 28 32" fill="none" aria-hidden="true">
                <path
                    d="m14 2 11 6v15l-11 7L3 23V8l11-6Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                />
                <path
                    d="m19 10-5-3-6 4 12 9-6 4-5-3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>
              SENTINEL<small>Mission control</small>
            </span>
          </a>
          <div
            className={`connection ${state.isActive ? "online" : "offline"}`}
            role="status"
          >
            <i />
            {status}
          </div>
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button
            aria-current={page === "rack" ? "page" : undefined}
            onClick={() => setPage("rack")}
          >
            <Icon name="rack" size={17} />
            Rack Monitor
          </button>
          <button
            aria-current={page === "fleet" ? "page" : undefined}
            onClick={() => setPage("fleet")}
          >
            <Icon name="fleet" size={17} />
            Fleet Simulation
          </button>
        </nav>
        {page === "rack" && rackSelection}
        <div className="sidebar-foot">
          <span className={`status-dot ${state.isActive ? "" : "inactive"}`} />
          {state.isActive ? "SpacetimeDB synchronized" : "Awaiting connection"}
        </div>
      </aside>
      <main id="main-content">
        {state.connectionError && (
          <div className="error" role="alert">
            {state.connectionError.message}
          </div>
        )}
        {page === "fleet" ? (
          <FleetSimulation />
        ) : (
          <>
            {rack ? (
              <RackView
                key={`${rack.rackId}:${reconnectKey}`}
                rack={rack}
                online={state.isActive}
              />
            ) : (
              <>
                <section className="panel empty-state">
                  <Icon name="rack" size={30} />
                  <h2>
                    {issuesOnly
                      ? "No racks match this filter"
                      : "Waiting for rack configuration"}
                  </h2>
                  <p>
                    {issuesOnly
                      ? "Clear Issues only to inspect all configured racks. Missing measurements still require inspection."
                      : "Rack configuration will appear when the backend subscription synchronizes."}
                  </p>
                </section>
              </>
            )}
          </>
        )}
        <footer>
          <span>
            <span className="footer-mark" />
            SENTINEL <span className="footer-divider">/</span> Observe.
            Investigate. Verify.
          </span>
          <span>
            Powered by NVIDIA Nemotron <span className="footer-divider">·</span>{" "}
            SpacetimeDB
          </span>
        </footer>
      </main>
    </div>
  );
}
