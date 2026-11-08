// Rover Live: real readings and camera feed straight from the rover (Jetson), polled fast for demos.
// The Vite dev server proxies /api/rover to ROVER_URL, so the browser only ever talks to localhost.
import { useEffect, useRef, useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "./module_bindings";
import Icon from "./Icon";

const ROVER = "/api/rover";
const DISPATCH = "/api/dispatch";
const POLL_MS = 500;

interface Reading {
  temp_c: number | null;
  hum: number | null;
  dist_cm: number | null;
  sound: number | null;
  age_s: number | null;
}

function useRover() {
  const [data, setData] = useState<Reading | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ t: number; temp: number | null; hum: number | null; sound: number | null }[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`${ROVER}/sensor`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as Reading;
        if (!alive) return;
        setData(d);
        setError("");
        setHistory((h) => [...h.slice(-119), { t: Date.now(), temp: d.temp_c, hum: d.hum, sound: d.sound }]);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return { data, error, history };
}

function Spark({ values, color }: { values: (number | null)[]; color: string }) {
  const v = values.filter((x): x is number => x !== null);
  if (v.length < 2) return <svg className="rover-spark" viewBox="0 0 100 28" />;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo || 1;
  const pts = values
    .map((x, i) => (x === null ? null : `${((i / (values.length - 1)) * 100).toFixed(1)},${(26 - ((x - lo) / span) * 24).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg className="rover-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Tile(props: { icon: "temperature" | "humidity" | "sound"; label: string; value: number | null | undefined; unit: string; digits: number; series: (number | null)[]; color: string }) {
  const prev = useRef<number | null | undefined>(undefined);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prev.current !== undefined && prev.current !== props.value) {
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 400);
      prev.current = props.value;
      return () => clearTimeout(id);
    }
    prev.current = props.value;
  }, [props.value]);
  return (
    <div className={`rover-tile ${flash ? "changed" : ""}`}>
      <div className="rover-tile-head">
        <Icon name={props.icon} size={16} />
        {props.label}
      </div>
      <div className="rover-tile-value">
        {props.value === null || props.value === undefined ? "--" : props.value.toFixed(props.digits)}
        <span>{props.unit}</span>
      </div>
      <Spark values={props.series} color={props.color} />
    </div>
  );
}

interface DispatchStatus {
  armed: boolean;
  last_trigger: string | null;
  triggers?: { temp_c: number; humidity_pct: number; sound_min: number; sound_factor: number };
  running: boolean;
  phase: string;
  rack: string | null;
  log: { t: string; m: string }[];
}

function MissionControl() {
  const [st, setSt] = useState<DispatchStatus | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${DISPATCH}/status`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as DispatchStatus;
        if (alive) { setSt(d); setErr(""); }
      } catch {
        if (alive) setErr("Dispatcher not running");
      }
    };
    void tick();
    const id = setInterval(tick, 700);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const post = (path: string) => fetch(`${DISPATCH}${path}`, { method: "POST" }).catch(() => setErr("Dispatcher not running"));
  return (
    <div className="rover-mission">
      <div className="rover-mission-row">
        <div>
          <div className="rover-mission-phase">
            {err ? err : st?.running ? `${st.phase}${st.rack ? ` · ${st.rack}` : ""}` : "Ready"}
          </div>
          {st?.triggers && (
            <div className="rover-triggers">
              <span>Temp &gt; {st.triggers.temp_c} °C</span>
              <span>Humidity &gt; {st.triggers.humidity_pct}%</span>
              <span>Sudden sound &gt; {st.triggers.sound_factor}× background</span>
              {st.last_trigger && <span className="fired">Last trigger: {st.last_trigger}</span>}
            </div>
          )}
          <ol className="rover-mission-log">
            {(st?.log ?? []).slice(-6).map((l, i) => (
              <li key={`${l.t}-${i}`} className={l.m.startsWith("AI sees") ? "ai" : l.m.startsWith("TRIGGER") ? "trig" : ""}>
                <span>{l.t}</span> {l.m}
              </li>
            ))}
          </ol>
        </div>
        <div className="rover-mission-buttons">
          <button
            className={`rover-btn arm ${st?.armed ? "on" : ""}`}
            disabled={Boolean(err)}
            onClick={() => void post(`/arm?on=${st?.armed ? 0 : 1}`)}
            title="Automatically send the rover when a trigger fires"
          >
            Live auto-checks {st?.armed ? "ON" : "OFF"}
          </button>
          <button className="rover-btn go" disabled={Boolean(err) || st?.running} onClick={() => void post("/patrol")}>
            Start Inspection
          </button>
          <button className="rover-btn stop" disabled={Boolean(err)} onClick={() => void post("/stop")}>
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}

type Obj = Record<string, unknown>;
const parse = (s: string): Obj => {
  try { return JSON.parse(s) as Obj; } catch { return {}; }
};
const sevClass = (s: string) => (s === "CRITICAL" ? "crit" : s === "WARNING" ? "warn" : s === "NORMAL" ? "ok" : "unk");

function RoverInspections() {
  const [investigations] = useTable(tables.investigation);
  const [images] = useTable(tables.investigationImage);
  const rover = images
    .filter((i) => i.sourceType === "ROVER_CAMERA")
    .map((img) => ({ img, inv: investigations.find((v) => v.investigationId === img.investigationId) }))
    .filter((x) => x.inv)
    .sort((a, b) => (a.img.uploadedAt.microsSinceUnixEpoch < b.img.uploadedAt.microsSinceUnixEpoch ? 1 : -1))
    .slice(0, 4);
  if (!rover.length)
    return <p className="rover-live-foot">No rover inspections yet. Start a patrol to capture the first photo.</p>;
  return (
    <div className="rover-inspections">
      {rover.map(({ img, inv }, idx) => {
        const report = parse(inv!.reportJson);
        const snap = parse(inv!.snapshotJson);
        const readings = (Array.isArray(snap.current_telemetry) ? snap.current_telemetry : []) as Obj[];
        const r = (m: string) => readings.find((x) => x.metric_type === m && x.source_type === "ROVER");
        const visual = (Array.isArray(report.visual_findings) ? report.visual_findings : []) as Obj[];
        const concerns = visual.filter((v) => v.potential_concern);
        const running = inv!.status === "RUNNING";
        const when = new Date(Number(img.uploadedAt.microsSinceUnixEpoch / 1000n)).toLocaleTimeString();
        return (
          <article key={img.investigationId} className={`rover-inspection ${idx === 0 ? "latest" : ""}`}>
            <div className="rover-inspection-photo">
              {img.thumbnailDataUrl ? <img src={img.thumbnailDataUrl} alt={`Rover photo of ${inv!.rackId}`} /> : <div className="noimg">No preview</div>}
              <span className="rover-photo-tag">ROVER CAMERA · {when}</span>
            </div>
            <div className="rover-inspection-body">
              <div className="rover-inspection-head">
                <h3>{inv!.rackId.replace("rack-", "Rack 0")}</h3>
                <span className={`rover-sev ${running ? "run" : sevClass(inv!.severity)}`}>{running ? "AI INVESTIGATING…" : inv!.severity}</span>
              </div>
              <div className="rover-readings">
                <span>{String(r("AMBIENT_TEMPERATURE_C")?.numeric_value ?? "--")} °C</span>
                <span>{String(r("RELATIVE_HUMIDITY_PERCENT")?.numeric_value ?? "--")} %RH</span>
                <span>Sound {String(r("SOUND_RAW")?.numeric_value ?? "--")}</span>
              </div>
              {!running && (
                <>
                  <p className="rover-headline">{String(report.headline ?? report.summary ?? "")}</p>
                  {concerns.length > 0 ? (
                    <ul className="rover-concerns">
                      {concerns.slice(0, 4).map((c, i) => (
                        <li key={i}>
                          <b>{String(c.component ?? "")}</b>: {String(c.potential_concern)}
                        </li>
                      ))}
                    </ul>
                  ) : visual.length > 0 ? (
                    <p className="rover-clear">No visual concerns found in the photo.</p>
                  ) : null}
                </>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function RoverLive() {
  const { data, error, history } = useRover();
  const [streamKey, setStreamKey] = useState(0);
  const offline = Boolean(error) || !data;
  const sensorsStale = !data || data.age_s === null || data.age_s > 5;
  return (
    <section className="rover-live">
      <header className="rover-live-head">
        <div>
          <p className="eyebrow">Rover</p>
          <h1>Rover Live</h1>
        </div>
        <span className={`rover-live-badge ${offline ? "off" : ""}`}>
          <i />
          {offline ? "ROVER OFFLINE" : sensorsStale ? "LIVE · SENSORS STALE" : "LIVE"}
        </span>
      </header>

      <MissionControl />

      <div className="rover-tiles">
        <Tile icon="temperature" label="Temperature" value={data?.temp_c} unit="°C" digits={1} series={history.map((h) => h.temp)} color="var(--amber)" />
        <Tile icon="humidity" label="Humidity" value={data?.hum} unit="%RH" digits={0} series={history.map((h) => h.hum)} color="var(--cyan)" />
        <Tile icon="sound" label="Sound (raw)" value={data?.sound} unit="" digits={0} series={history.map((h) => h.sound)} color="var(--green)" />
      </div>

      <h2 className="rover-section">Rover inspections</h2>
      <RoverInspections />

      <h2 className="rover-section">Live camera</h2>
      <div className={`rover-feed ${offline ? "off" : ""}`}>
        <img key={streamKey} src={`${ROVER}/stream?k=${streamKey}`} alt="Live rover camera" onError={() => setTimeout(() => setStreamKey((k) => k + 1), 2000)} />
        <span className="rover-feed-tag">
          <i /> REC · Rover camera
        </span>
      </div>

      <p className="rover-live-foot">
        Real sensors on the rover, refreshed every {POLL_MS / 1000} s. Distance (collision safety):{" "}
        {data?.dist_cm === null || data?.dist_cm === undefined ? "--" : `${data.dist_cm.toFixed(1)} cm`}
        {error ? ` · ${error}` : ""}
      </p>
    </section>
  );
}
