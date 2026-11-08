// Rover Live: real readings and camera feed straight from the rover (Jetson), polled fast for demos.
// The Vite dev server proxies /api/rover to ROVER_URL, so the browser only ever talks to localhost.
import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

const ROVER = "/api/rover";
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

      <div className="rover-tiles">
        <Tile icon="temperature" label="Temperature" value={data?.temp_c} unit="°C" digits={1} series={history.map((h) => h.temp)} color="var(--amber)" />
        <Tile icon="humidity" label="Humidity" value={data?.hum} unit="%RH" digits={0} series={history.map((h) => h.hum)} color="var(--cyan)" />
        <Tile icon="sound" label="Sound (raw)" value={data?.sound} unit="" digits={0} series={history.map((h) => h.sound)} color="var(--green)" />
      </div>

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
