import { useState } from "react";
import Icon from "./Icon";
export default function FleetSimulation() {
  const [rovers, setRovers] = useState(1000);
  const [rate, setRate] = useState(1);
  return (
    <section className="fleet-page" aria-labelledby="fleet-title">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Scale, with evidence</span>
          <h1 id="fleet-title">Fleet Simulation</h1>
          <p>Define a virtual fleet. Measure what actually arrives.</p>
        </div>
        <span className="pill">Integration pending</span>
      </div>
      <section className="panel fleet-config">
        <div className="panel-heading">
          <div className="title-with-icon">
            <Icon name="fleet" />
            <h2>Configure virtual fleet</h2>
          </div>
          <span className="source-tag">Simulated only</span>
        </div>
        <div className="fleet-controls">
          <label>
            Virtual Rovers
            <select
              aria-label="Virtual Rovers"
              value={rovers}
              onChange={(e) => setRovers(Number(e.target.value))}
            >
              {[10, 100, 1000, 5000].map((n) => (
                <option value={n} key={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <label>
            Events per Rover per Second
            <select
              aria-label="Events per Rover per Second"
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            >
              {[1, 2, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="target-rate">
          <span>Target event rate</span>
          <strong>
            {(rovers * rate).toLocaleString()} <small>events/sec</small>
          </strong>
          <p>
            {rovers.toLocaleString()} rovers × {rate} events/second ·
            configuration target, not measured throughput
          </p>
        </div>
        <div className="action-row">
          <button
            className="primary-button"
            disabled
            aria-describedby="fleet-unavailable"
          >
            Start Simulation <Icon name="arrow" size={16} />
          </button>
          <button disabled>Stop Simulation</button>
        </div>
        <p className="integration-note" id="fleet-unavailable">
          Fleet publishing and benchmark collection are not implemented in this
          backend. These controls define the UI contract; no fleet is running.
        </p>
      </section>
      <div className="benchmark-grid" aria-label="Benchmark results">
        {[
          ["Measured throughput", "events/sec"],
          ["Delivery latency", "ms"],
          ["Dropped events", "events"],
        ].map(([name, unit]) => (
          <div className="panel benchmark" key={name}>
            <span>{name}</span>
            <strong>Not measured</strong>
            <small>{unit} · requires benchmark integration</small>
          </div>
        ))}
      </div>
      <p className="quiet-note">
        No synthetic benchmark results. No physical rover control.
      </p>
    </section>
  );
}
