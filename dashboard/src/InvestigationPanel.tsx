import { useEffect, useMemo, useState } from "react";
import { Timestamp } from "spacetimedb";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { DbConnection, tables } from "./module_bindings";
import type {
  Rack,
  RackProfile,
  CurrentTelemetry,
  RecentObservation,
  RackAlert,
  Investigation,
  InvestigationImage,
} from "./module_bindings/types";
import {
  buildInvestigationRequest,
  snapshotForStorage,
  validateInvestigationResponse,
  type AgentEvent,
  type AgentReport,
  type ImageAttachment,
  type ImageSourceType,
  type InspectionMode,
  VERIFICATION_LABEL,
} from "./investigation";
import EquipmentEvidence from "./EquipmentEvidence";
import { prepareImage } from "./imageUpload";
import { date } from "./telemetry";

const AGENT_URL = "/api/agent/investigate"; // Vite proxy -> agent service (port 3001); no API key in the browser
const CLIENT_TIMEOUT_MS = 180_000; // agent budget: 90 s (130 s with a photo) plus synthesis
const ABANDONED_AFTER_MS = 5 * 60_000; // RUNNING rows older than this no longer block new runs

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const micros = (r: Investigation) => r.createdAt.microsSinceUnixEpoch;
const SOURCE_LABEL: Record<string, string> = {
  MANUAL_UPLOAD: "Manual upload",
  ONLINE_REFERENCE: "Online reference — not captured by SENTINEL",
  ROVER_CAMERA: "Rover camera",
};

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
  const [rows, rowsReady] = useTable(
    tables.investigation.where((r) => r.rackId.eq(rack.rackId)),
  );
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imageRows] = useTable(
    tables.investigationImage.where((r) => r.rackId.eq(rack.rackId)),
  );
  // Image to inspect (local only until a run; bytes are sent to the agent, never stored).
  const [image, setImage] = useState<ImageAttachment | null>(null);
  const [preview, setPreview] = useState("");
  const [imageError, setImageError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [sourceType, setSourceType] =
    useState<ImageSourceType>("MANUAL_UPLOAD");
  const [sourceUrl, setSourceUrl] = useState("");
  const [attribution, setAttribution] = useState("");
  const [license, setLicense] = useState("");
  const [captureTime, setCaptureTime] = useState("");
  const [includeTelemetry, setIncludeTelemetry] = useState(true);
  const [fileKey, setFileKey] = useState(0);
  const [manufacturer, setManufacturer] = useState("");
  const [equipmentModel, setEquipmentModel] = useState("");
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const identityReady =
    (!manufacturer.trim() && !equipmentModel.trim() && !identityConfirmed) ||
    (Boolean(manufacturer.trim()) &&
      Boolean(equipmentModel.trim()) &&
      identityConfirmed);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  async function selectFile(file: File | undefined) {
    setImageError("");
    clearImage(false);
    if (!file) return;
    setPreparing(true);
    try {
      const prepared = await prepareImage(file, {
        sourceType,
        sourceUrl,
        attribution,
        license,
        captureTime,
      });
      setImage(prepared);
      setPreview(URL.createObjectURL(file));
    } catch (e) {
      setImageError((e as Error).message);
      setFileKey((k) => k + 1);
    } finally {
      setPreparing(false);
    }
  }
  function clearImage(resetInput = true) {
    setImage(null);
    setPreview("");
    if (resetInput) setFileKey((k) => k + 1);
  }

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        micros(b) > micros(a) ? 1 : micros(b) < micros(a) ? -1 : 0,
      ),
    [rows],
  );
  const shown =
    sorted.find((r) => r.investigationId === selectedId) ?? sorted[0];
  const runningElsewhere = sorted.some(
    (r) =>
      r.status === "RUNNING" &&
      Date.now() - Number(micros(r) / 1000n) < ABANDONED_AFTER_MS,
  );

  async function run(
    mode: InspectionMode = "TELEMETRY",
    img?: ImageAttachment,
  ) {
    if (busy || runningElsewhere || !identityReady) return; // duplicate-request guard (local + any session)
    const db = state.getConnection() as DbConnection | null;
    if (!db || !ready || !rowsReady || !profile) {
      setLocalError("Subscriptions are not synchronized yet.");
      return;
    }
    setBusy(true);
    setLocalError("");
    // One logical snapshot of the subscribed rows for this rack, captured at click time.
    // Provenance as entered at run time (fields may change after the file was chosen).
    const attached = img && {
      ...img,
      sourceType,
      sourceUrl: sourceUrl.trim(),
      attribution: attribution.trim(),
      license: license.trim(),
      captureTimestamp: captureTime
        ? new Date(captureTime).toISOString()
        : null,
    };
    const request = buildInvestigationRequest(
      {
        rack,
        profile,
        current: props.current,
        recent: props.history,
        alerts: props.alerts,
        asOf: new Date(),
        staleAfterSeconds: props.freshnessSeconds,
      },
      {
        ...(mode === "TELEMETRY" ? {} : { mode, image: attached }),
        ...(identityConfirmed
          ? {
              equipmentIdentity: {
                manufacturer: manufacturer.trim(),
                model: equipmentModel.trim(),
                provenance: "OPERATOR_PROVIDED" as const,
                assertion:
                  "Operator explicitly identifies this manufacturer and model as installed equipment in the selected rack; not inferred from a photograph or generic profile.",
              },
            }
          : {}),
      },
    );
    const investigationId = crypto.randomUUID();
    try {
      await db.reducers.startInvestigation({
        investigationId,
        rackId: rack.rackId,
        snapshotJson: JSON.stringify(snapshotForStorage(request, attached)),
      });
      if (attached)
        await db.reducers.attachInvestigationImage({
          investigationId,
          imageId: attached.imageId,
          filename: attached.filename,
          mimeType: attached.mimeType,
          sourceType: attached.sourceType,
          captureTimestamp: attached.captureTimestamp
            ? new Timestamp(
                BigInt(Date.parse(attached.captureTimestamp)) * 1000n,
              )
            : undefined,
          sourceUrl: attached.sourceUrl,
          attribution: attached.attribution,
          license: attached.license,
          sha256: attached.sha256,
          byteSize: attached.byteSize,
          width: attached.width,
          height: attached.height,
          thumbnailDataUrl: attached.thumbnailDataUrl,
        });
    } catch (e) {
      setLocalError(
        `Could not record the investigation in SpacetimeDB: ${(e as Error).message}`,
      );
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
      if (!body?.report)
        throw new Error(
          body?.message ??
            body?.error ??
            `Agent service returned HTTP ${res.status}`,
        );
      const { report, events } = validateInvestigationResponse(
        body,
        rack.rackId,
        Boolean(attached),
      );
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
      await db.reducers.completeInvestigation({
        investigationId,
        status,
        severity,
        reportJson,
        eventsJson,
      });
    } catch (e) {
      setLocalError(
        `Investigation finished but could not be saved: ${(e as Error).message}`,
      );
    }
    setBusy(false);
  }

  const shownImage = shown
    ? imageRows.find((r) => r.investigationId === shown.investigationId)
    : undefined;
  const report =
    shown && shown.status !== "RUNNING"
      ? parse<Partial<AgentReport> & { error?: string }>(shown.reportJson, {})
      : null;
  const events = shown ? parse<AgentEvent[]>(shown.eventsJson, []) : [];
  const abandoned =
    shown?.status === "RUNNING" &&
    Date.now() - Number(micros(shown) / 1000n) >= ABANDONED_AFTER_MS;

  return (
    <section className="panel investigation" data-testid="investigation-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">NVIDIA NEMOTRON · MULTI-AGENT</span>
          <h2>AI investigation</h2>
        </div>
        <button
          className="investigate-button"
          onClick={() => void run("TELEMETRY")}
          disabled={
            !ready || !rowsReady || busy || runningElsewhere || !identityReady
          }
        >
          {busy || runningElsewhere
            ? "Investigation running…"
            : "Run AI Investigation"}
        </button>
      </div>
      <p className="muted">
        Runs only when requested. A Supervisor agent delegates to Telemetry,
        Environment, Documentation, Vision and Verification agents using this
        rack's subscribed data. AI output is hypotheses, not confirmed faults.
      </p>
      <fieldset
        className="equipment-identity"
        disabled={busy || runningElsewhere}
      >
        <legend>
          Installed equipment identity{" "}
          <small>optional ? operator assertion for this rack</small>
        </legend>
        <div className="identity-fields">
          <label>
            Manufacturer
            <input
              aria-label="Equipment manufacturer"
              value={manufacturer}
              maxLength={80}
              placeholder="Unknown"
              onChange={(e) => {
                setManufacturer(e.target.value);
                setIdentityConfirmed(false);
              }}
            />
          </label>
          <label>
            Exact model
            <input
              aria-label="Equipment model"
              value={equipmentModel}
              maxLength={120}
              placeholder="Unknown"
              onChange={(e) => {
                setEquipmentModel(e.target.value);
                setIdentityConfirmed(false);
              }}
            />
          </label>
        </div>
        <label className="vision-check">
          <input
            aria-label="Confirm installed equipment identity"
            type="checkbox"
            checked={identityConfirmed}
            onChange={(e) => setIdentityConfirmed(e.target.checked)}
          />
          I explicitly identify this equipment as installed in the selected
          rack.
        </label>
        <p className="muted">
          Leave blank when unknown. A generic profile or branding in a reference
          photograph does not establish installed equipment. Model-specific
          guidance requires an exact knowledge-base match.
        </p>
        {!identityReady && (
          <p className="inv-warning">
            Supply both fields and confirm, or clear both fields to investigate
            unidentified equipment.
          </p>
        )}
      </fieldset>
      <div className="vision-upload" data-testid="vision-upload">
        <div className="vision-controls">
          <label>
            Inspection photo <small>JPEG or PNG · max 4 MB · max 4096 px</small>
            <input
              key={fileKey}
              type="file"
              accept="image/jpeg,image/png"
              aria-label="Inspection photo"
              disabled={busy || preparing}
              onChange={(e) => void selectFile(e.target.files?.[0])}
            />
          </label>
          <label>
            Image source
            <select
              aria-label="Image source"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as ImageSourceType)}
            >
              <option value="MANUAL_UPLOAD">Manual upload</option>
              <option value="ONLINE_REFERENCE">Online reference image</option>
              <option value="ROVER_CAMERA" disabled>
                Rover camera (not yet connected)
              </option>
            </select>
          </label>
          {sourceType === "ONLINE_REFERENCE" && (
            <>
              <label>
                Source page URL
                <input
                  aria-label="Source page URL"
                  value={sourceUrl}
                  maxLength={500}
                  placeholder="https://…"
                  onChange={(e) => setSourceUrl(e.target.value)}
                />
              </label>
              <label>
                Attribution
                <input
                  aria-label="Attribution"
                  value={attribution}
                  maxLength={300}
                  onChange={(e) => setAttribution(e.target.value)}
                />
              </label>
              <label>
                License
                <input
                  aria-label="License"
                  value={license}
                  maxLength={100}
                  onChange={(e) => setLicense(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            Capture time <small>(blank = unknown)</small>
            <input
              aria-label="Capture time"
              type="datetime-local"
              step="1"
              value={captureTime}
              onChange={(e) => setCaptureTime(e.target.value)}
            />
          </label>
          <label className="vision-check">
            <input
              type="checkbox"
              aria-label="Include current rack telemetry"
              checked={includeTelemetry}
              onChange={(e) => setIncludeTelemetry(e.target.checked)}
            />
            Include current rack telemetry
          </label>
        </div>
        {preparing && <p className="inv-running">Validating image…</p>}
        {imageError && (
          <div className="error" role="alert">
            {imageError}
          </div>
        )}
        {image && (
          <div className="vision-preview">
            <img
              src={preview}
              alt={`Selected inspection photo ${image.filename}`}
            />
            <div className="inv-meta">
              <b>{image.filename}</b> · {image.width}×{image.height} ·{" "}
              {(image.byteSize / 1024).toFixed(0)} KB ·{" "}
              {SOURCE_LABEL[sourceType]}
              <br />
              sha256 {image.sha256.slice(0, 16)}…
              <div className="vision-actions">
                <button
                  type="button"
                  onClick={() => clearImage()}
                  disabled={busy}
                >
                  Remove image
                </button>
                <button
                  type="button"
                  className="investigate-button"
                  onClick={() =>
                    void run(includeTelemetry ? "COMBINED" : "VISUAL", image)
                  }
                  disabled={!ready || !rowsReady || busy || runningElsewhere || !identityReady}
                >
                  {busy || runningElsewhere
                    ? "Investigation running…"
                    : "Run Visual Inspection"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {localError && (
        <div className="error" role="alert">
          {localError}
        </div>
      )}
      {sorted.length > 1 && (
        <label className="inv-history">
          History{" "}
          <select
            value={shown?.investigationId}
            onChange={(e) => setSelectedId(e.target.value)}
            aria-label="Investigation history"
          >
            {sorted.map((r) => (
              <option key={r.investigationId} value={r.investigationId}>
                {date(r.createdAt)} · {r.status} · {r.severity} ·{" "}
                {r.profileName}
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
        <div
          className="inv-body"
          data-testid="investigation-record"
          data-id={shown.investigationId}
          data-status={shown.status}
          data-severity={shown.severity}
        >
          <div className="inv-status-row">
            <span className={`inv-badge status-${shown.status.toLowerCase()}`}>
              {abandoned ? "ABANDONED" : shown.status}
            </span>
            {shown.status !== "RUNNING" && (
              <span className={`inv-badge sev-${shown.severity.toLowerCase()}`}>
                {shown.severity}
              </span>
            )}
            {shown.telemetrySimulated &&
              report?.inspection_mode !== "VISUAL" && (
                <span className="sim-label">SIMULATED TELEMETRY</span>
              )}
            {report?.inspection_mode &&
              report.inspection_mode !== "TELEMETRY" && (
                <span className="inv-badge">{report.inspection_mode}</span>
              )}
            {report?.verification_outcome && (
              <span
                className={`inv-badge ${report.verification_outcome === "VERIFIED" ? "status-completed" : report.verification_outcome === "NOT_REQUIRED" ? "" : "status-incomplete"}`}
                data-testid="verification-outcome"
                data-outcome={report.verification_outcome}
              >
                {VERIFICATION_LABEL[report.verification_outcome]}
              </span>
            )}
            <span className="inv-meta">
              Profile at run: {shown.profileName} · Started{" "}
              {date(shown.createdAt)}
              {shown.completedAt
                ? ` · Finished ${date(shown.completedAt)}`
                : ""}
            </span>
          </div>

          {shown.status === "RUNNING" && !abandoned && (
            <p className="inv-running">
              Agents are investigating… results will appear here for every
              connected session.
            </p>
          )}
          {abandoned && (
            <p className="error">
              No completion was recorded for this investigation. Treat it as
              failed.
            </p>
          )}
          {shown.status === "FAILED" && (
            <p className="error">
              Investigation failed. No diagnosis was produced.{" "}
              {report?.error ?? report?.summary ?? ""}
            </p>
          )}
          {shown.status === "INCOMPLETE" && (
            <div className="inv-warning">
              Incomplete investigation
              {!report?.incomplete_reasons?.length && report?.limits_reached?.length
                ? ` (limits reached: ${report.limits_reached.join(", ")})`
                : ""}
              . Treat the diagnosis as partial.
              {!!report?.incomplete_reasons?.length && (
                <ul className="inv-list" data-testid="incomplete-reasons">
                  {report.incomplete_reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {shownImage && <ImageProvenanceView img={shownImage} />}
          {report && report.summary && shown.status !== "FAILED" && (
            <>
              {!!report.visual_findings?.length && (
                <>
                  <h3 className="inv-h">
                    Visual observations{" "}
                    <small>
                      Vision Agent · AI-described, not confirmed faults
                    </small>
                  </h3>
                  <ul className="inv-list visual" data-testid="visual-findings">
                    {report.visual_findings.map((v, i) => (
                      <li key={i}>
                        <span
                          className={`inv-badge ${v.certainty === "CERTAIN" ? "status-completed" : "status-incomplete"}`}
                        >
                          {v.certainty}
                        </span>{" "}
                        <code>{v.category}</code> {v.observation}
                        {v.image_location && (
                          <small> · {v.image_location}</small>
                        )}
                        {v.visual_evidence && (
                          <div className="ev">
                            Evidence: {v.visual_evidence}
                          </div>
                        )}
                        {v.potential_concern && (
                          <div className="ev missing">
                            Possible concern: {v.potential_concern}
                          </div>
                        )}
                        {v.limitations && (
                          <div className="ev">Limitations: {v.limitations}</div>
                        )}
                        {v.recommended_follow_up && (
                          <div className="ev plus">
                            Follow-up: {v.recommended_follow_up}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {report.evidence && (
                <EquipmentEvidence evidence={report.evidence} />
              )}
              <h3 className="inv-h">
                Final diagnosis <small>AI-written summary</small>
              </h3>
              <p className="inv-summary">{report.summary}</p>

              <div className="inv-grid">
                <div>
                  <h3 className="inv-h">
                    Measured facts{" "}
                    <small>from tool output, not AI-written</small>
                  </h3>
                  <ul className="inv-list facts">
                    {(report.evidence?.measurements ?? []).map((m, i) => (
                      <li key={i}>
                        <b>{String(m.metric_type)}</b> {String(m.numeric_value)}{" "}
                        {String(m.unit)}{" "}
                        <small>
                          {String(m.source_type)} ·{" "}
                          {String(m.source_identifier)} ·{" "}
                          {String(m.observed_at)}
                          {m.stale ? " · STALE" : ""}
                        </small>
                      </li>
                    ))}
                    {!report.evidence?.measurements?.length && (
                      <li className="muted-item">
                        No current readings were retrieved.
                      </li>
                    )}
                    {report.evidence?.configured_thresholds && (
                      <li>
                        <b>Thresholds</b> warn{" "}
                        {String(
                          report.evidence.configured_thresholds
                            .temperature_warning_c,
                        )}{" "}
                        / crit{" "}
                        {String(
                          report.evidence.configured_thresholds
                            .temperature_critical_c,
                        )}{" "}
                        °C <small>fictional demo configuration</small>
                      </li>
                    )}
                  </ul>
                </div>
                <div>
                  <h3 className="inv-h">
                    AI hypotheses <small>not confirmed faults</small>
                  </h3>
                  <ul className="inv-list">
                    {(report.hypotheses ?? []).map((h, i) => (
                      <li key={i}>
                        {h.description}
                        {h.supporting_evidence.map((e, j) => (
                          <div key={`s${j}`} className="ev plus">
                            + {e}
                          </div>
                        ))}
                        {h.contradicting_evidence.map((e, j) => (
                          <div key={`c${j}`} className="ev minus">
                            − {e}
                          </div>
                        ))}
                        {h.missing_evidence.map((e, j) => (
                          <div key={`m${j}`} className="ev missing">
                            ? {e}
                          </div>
                        ))}
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
                      {report.verification_outcome
                        ? VERIFICATION_LABEL[report.verification_outcome]
                        : report.verification
                          ? report.verification.grounded
                            ? "findings grounded"
                            : "grounding problems found"
                          : "not run"}
                    </small>
                  </h3>
                  <ul className="inv-list">
                    {(report.verified_findings ?? []).map((f, i) => (
                      <li key={`v${i}`}>✓ {f}</li>
                    ))}
                    {(report.verification?.unsupported_claims ?? []).map(
                      (f, i) => (
                        <li key={`u${i}`} className="ev minus">
                          Unsupported: {f}
                        </li>
                      ),
                    )}
                    {(report.verification?.contradictions ?? []).map((f, i) => (
                      <li key={`x${i}`} className="ev minus">
                        Contradiction: {f}
                      </li>
                    ))}
                    {report.verification?.request_more_investigation && (
                      <li className="ev missing">
                        Requested follow-up:{" "}
                        {report.verification.follow_up_agent} —{" "}
                        {report.verification.follow_up_objective}
                      </li>
                    )}
                  </ul>
                </div>
                <div>
                  <h3 className="inv-h">Missing evidence</h3>
                  <ul className="inv-list">
                    {(report.missing_information ?? []).map((f, i) => (
                      <li key={i} className="ev missing">
                        {f}
                      </li>
                    ))}
                  </ul>
                  <h3 className="inv-h">Recommended next inspection</h3>
                  <ul className="inv-list">
                    {(report.recommended_next_inspection ?? []).map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <details className="inv-details">
                <summary>
                  Supervisor plan &amp; agents:{" "}
                  {(report.agents_invoked ?? [])
                    .map((a) => a.agent)
                    .join(" → ") || "none"}
                </summary>
                <p className="inv-plan">{report.supervisor_plan}</p>
                {(report.specialist_findings ?? []).map((f, i) => (
                  <div key={i} className="inv-finding">
                    <b>{f.agent.toUpperCase()}</b>{" "}
                    <small>
                      [{f.status}] {f.objective}
                    </small>
                    <ul className="inv-list">
                      {f.observations.map((o, j) => (
                        <li key={j}>{o}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <small className="inv-meta">Model: {report.model}</small>
              </details>
            </>
          )}

          {events.length > 0 && (
            <details className="inv-details">
              <summary>
                Execution timeline ({events.length} events, recorded during the
                run)
              </summary>
              <ol className="inv-timeline">
                {events.map((e, i) => (
                  <li
                    key={i}
                    className={e.status === "ERROR" ? "ev minus" : ""}
                  >
                    <code>{e.type}</code> {e.description}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
      <div className="alert-note">
        Local demo trust model: investigation records are submitted by the
        dashboard client and validated for shape and consistency by SpacetimeDB;
        they are not cryptographically attested as agent output.
      </div>
    </section>
  );
}

function ImageProvenanceView({ img }: { img: InvestigationImage }) {
  return (
    <div className="vision-preview stored" data-testid="image-provenance">
      {img.thumbnailDataUrl ? (
        <img src={img.thumbnailDataUrl} alt={`Preview of ${img.filename}`} />
      ) : (
        <div className="no-thumb">No preview</div>
      )}
      <div className="inv-meta">
        <b>{img.filename}</b> · {img.width}×{img.height} ·{" "}
        {(img.byteSize / 1024).toFixed(0)} KB ·{" "}
        <span className="sim-label">
          {SOURCE_LABEL[img.sourceType] ?? img.sourceType}
        </span>
        <br />
        Image ID {img.imageId} · sha256 {img.sha256.slice(0, 16)}…
        <br />
        Captured:{" "}
        {img.captureTimestamp ? date(img.captureTimestamp) : "unknown"} ·
        Uploaded: {date(img.uploadedAt)}
        {img.sourceUrl && (
          <>
            <br />
            Source:{" "}
            <a href={img.sourceUrl} target="_blank" rel="noreferrer noopener">
              {img.sourceUrl}
            </a>
          </>
        )}
        {(img.attribution || img.license) && (
          <>
            <br />
            {img.attribution}
            {img.attribution && img.license ? " · " : ""}
            {img.license}
          </>
        )}
        <br />
        <small>
          Only this preview and the image's metadata are stored; the full image
          is not retained.
        </small>
      </div>
    </div>
  );
}
