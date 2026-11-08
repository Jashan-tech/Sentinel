import type { AgentReport } from "./investigation";
const text = (v: unknown) =>
  v === null || v === undefined ? "Unavailable" : String(v);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
const strings = (v: unknown) =>
  Array.isArray(v) ? v.map(String).join(" · ") : "";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const sourceUrl = (v: unknown) =>
  typeof v === "string" && /^https:\/\//.test(v) ? v : undefined;
export default function EquipmentEvidence({
  evidence,
}: {
  evidence: AgentReport["evidence"];
}) {
  if (!evidence.trends) return null; // Historical Feature 1–4 reports remain readable.
  const match = evidence.documentation_match;
  const documents = list(match?.documents).filter(
    (d) =>
      d.source_type === "MANUFACTURER_SPECIFICATION" &&
      d.availability !== "UNAVAILABLE",
  );
  return (
    <section className="equipment-evidence" data-testid="equipment-evidence">
      <h3 className="inv-h">
        Equipment intelligence{" "}
        <small>deterministic evidence · no failure forecasts</small>
      </h3>
      <p className="inv-meta">
        {evidence.equipment_identity
          ? `${evidence.equipment_identity.manufacturer} ${evidence.equipment_identity.model} · OPERATOR PROVIDED`
          : "Equipment identity unknown · model-specific guidance unavailable"}
      </p>
      <div className="trend-table-wrap">
        <table className="trend-table">
          <caption>Observed history per sensor · sampled windows only</caption>
          <thead>
            <tr>
              <th>Metric / source</th>
              <th>Window / samples</th>
              <th>First → last</th>
              <th>Change / minute</th>
              <th>Direction / quality</th>
            </tr>
          </thead>
          <tbody>
            {evidence.trends.map((t) => {
              const series = list(t.series);
              return series.length ? (
                series.map((s) => {
                  const w = object(s.observation_window);
                  return (
                    <tr key={`${t.metric_type}:${s.series_id}`}>
                      <td>
                        {text(t.metric_type)}
                        <small>
                          {text(s.source_type)} · {text(s.source_identifier)}
                        </small>
                        <small>{text(s.provenance)}</small>
                      </td>
                      <td>
                        {text(w.first_observed_at)}
                        <small>to {text(w.last_observed_at)}</small>
                        <small>
                          {text(s.observation_count)} observations ·{" "}
                          {text(s.elapsed_seconds)} seconds
                        </small>
                      </td>
                      <td>
                        {text(s.first_value)} → {text(s.last_value)}{" "}
                        {text(s.unit)}
                        <small>
                          Δ {text(s.absolute_change)} · min {text(s.minimum)} /
                          max {text(s.maximum)} / avg {text(s.average)}
                        </small>
                      </td>
                      <td>
                        {typeof s.change_per_minute === "number"
                          ? s.change_per_minute.toFixed(3)
                          : "Unavailable"}{" "}
                        {text(s.unit)}/min
                        <small>
                          {text(s.threshold_violations)} warning breaches
                        </small>
                        <small>
                          Sampled abnormal span:{" "}
                          {text(s.observed_abnormal_span_seconds)} s
                        </small>
                      </td>
                      <td>
                        {text(s.direction)}
                        {s.stale === true ? " · STALE" : ""}
                        <small>{strings(s.data_quality)}</small>
                        <small>
                          Excluded: {text(t.rejected_observations)} invalid /{" "}
                          {text(s.conflicting_observations_excluded)}{" "}
                          conflicting
                        </small>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr key={text(t.metric_type)}>
                  <td>{text(t.metric_type)}</td>
                  <td colSpan={4}>
                    Insufficient data · no valid history. Excluded{" "}
                    {text(t.rejected_observations)} invalid samples.
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3 className="inv-h">
        Monitoring indicators{" "}
        <small>
          observed conditions and early warnings, not confirmed faults
        </small>
      </h3>
      <ul className="inv-list" data-testid="early-warning-indicators">
        {list(evidence.early_warning_indicators).map((i) => (
          <li key={text(i.indicator_id)}>
            <span className="inv-badge">{text(i.severity)}</span>{" "}
            <code>{text(i.classification)}</code> · {text(i.metric)}
            <p>{text(i.explanation)}</p>
            <small>
              Rule: {text(i.triggering_rule)} ·{" "}
              {text(object(i.observed_evidence).source_type)} ·{" "}
              {text(object(i.observed_evidence).source_identifier)}
            </small>
            <div className="ev">
              Window: {text(object(i.observation_window).first_observed_at)} →{" "}
              {text(object(i.observation_window).last_observed_at)}
            </div>
            <div className="ev missing">
              Missing: {strings(i.missing_information)}
            </div>
            <div className="ev plus">
              Next inspection: {text(i.recommended_next_inspection)}
            </div>
            <details>
              <summary>Observed evidence</summary>
              <pre>{JSON.stringify(i.observed_evidence, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
      <h3 className="inv-h">
        Applicable manufacturer references{" "}
        <small>{text(match?.match_status)}</small>
      </h3>
      {!documents.length ? (
        <p className="inv-warning">
          No matching model-specific documentation. {text(match?.note)}
        </p>
      ) : (
        <ul className="inv-list">
          {documents.map((d) => (
            <li key={text(d.doc_id)}>
              <a
                href={sourceUrl(d.source_url)}
                target="_blank"
                rel="noreferrer"
              >
                {text(d.doc_id)} · {text(d.title)}
              </a>
              <small>
                {text(d.section)} · {text(d.revision)} · accessed{" "}
                {text(d.access_date)}
              </small>
              <ul>
                {list(d.technical_facts).map((f) => (
                  <li key={text(f.fact_id)}>
                    {text(f.fact_id)}: {text(f.statement)}
                  </li>
                ))}
              </ul>
              <div className="ev">
                Applies when: {strings(d.applicability_conditions)}
              </div>
              <div className="ev missing">
                Limitations: {strings(d.limitations)}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="inv-meta">
        Profile limits are fictional demonstration settings. Historical sampled
        spans do not prove continuous abnormality; no missing measurements are
        interpolated.
      </p>
    </section>
  );
}
