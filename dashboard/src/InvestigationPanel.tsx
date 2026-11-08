import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
} from "./investigation";
import Icon from "./Icon";
import EquipmentEvidence from "./EquipmentEvidence";
import { prepareImage } from "./imageUpload";
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
  telemetry: ReactNode;
}) {
  const { rack, profile, ready } = props;
  const state = useSpacetimeDB();
  const [rows, rowsReady] = useTable(
    tables.investigation.where((r) => r.rackId.eq(rack.rackId)),
  );
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [phase, setPhase] = useState("");
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
  const shown = sorted[0];
  const runningElsewhere = sorted.some(
    (r) =>
      r.status === "RUNNING" &&
      Date.now() - Number(micros(r) / 1000n) < ABANDONED_AFTER_MS,
  );

  async function run(
    mode: InspectionMode = "TELEMETRY",
    img?: ImageAttachment,
  ) {
    if (inFlight.current || busy || runningElsewhere || !identityReady) return; // duplicate-request guard (local + any session)
    const db = state.getConnection() as DbConnection | null;
    if (!db || !ready || !rowsReady || !profile) {
      setLocalError("Subscriptions are not synchronized yet.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setPhase("Recording investigation…");
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
      inFlight.current = false;
      setBusy(false);
      return;
    }
    setSelectedId(investigationId);

    let status = "FAILED";
    let severity = "UNKNOWN";
    let reportJson = "";
    let eventsJson = "[]";
    try {
      setPhase(
        "Nemotron is investigating. The execution timeline arrives with the saved report.",
      );
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
    setPhase("Saving investigation result…");
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
    inFlight.current = false;
    setBusy(false);
  }

  const report =
    shown && shown.status !== "RUNNING"
      ? parse<Partial<AgentReport> & { error?: string }>(shown.reportJson, {})
      : null;
  const events = shown ? parse<AgentEvent[]>(shown.eventsJson, []) : [];
  const shownImage = imageRows.find(
    (r) => r.investigationId === shown?.investigationId,
  );
  const abandoned =
    shown?.status === "RUNNING" &&
    Date.now() - Number(micros(shown) / 1000n) >= ABANDONED_AFTER_MS;
  const disabled =
    !ready ||
    !rowsReady ||
    busy ||
    runningElsewhere ||
    !identityReady ||
    preparing;
  const historyRow =
    sorted.find((r) => r.investigationId === selectedId) ?? shown;
  const detailReport =
    historyRow && historyRow.status !== "RUNNING"
      ? parse<Partial<AgentReport>>(historyRow.reportJson, {})
      : null;
  const detailEvents = historyRow
    ? parse<AgentEvent[]>(historyRow.eventsJson, [])
    : [];
  const review = verificationLabel(report);
  return (
    <div className="monitor-grid">
      <div className="monitor-left">
        {props.telemetry}
        <div
          className="investigation-actions"
          aria-label="Investigation controls"
        >
          <button
            className="primary-button investigate-button"
            onClick={() =>
              void run(
                image
                  ? includeTelemetry
                    ? "COMBINED"
                    : "VISUAL"
                  : "TELEMETRY",
                image ?? undefined,
              )
            }
            disabled={disabled}
          >
            <Icon name="scan" size={18} />
            {busy || runningElsewhere
              ? "Investigation running…"
              : "Run Investigation"}
            <Icon name="arrow" size={17} />
          </button>
          <button
            className="upload-button"
            aria-expanded={photoOpen}
            aria-controls="photo-controls"
            onClick={() => setPhotoOpen((v) => !v)}
            disabled={busy || runningElsewhere}
          >
            <Icon name="photo" size={18} />
            Upload Photo
          </button>
        </div>
        <p className="action-caption">
          NVIDIA Nemotron · Multi-agent reasoning
          {image ? " · Photo attached" : ""}
        </p>
        {localError && (
          <div className="error" role="alert">
            {localError}
          </div>
        )}
        {photoOpen && (
          <section className="panel photo-panel" id="photo-controls">
            <div className="panel-heading">
              <h2>Inspection photo</h2>
              <span className="source-tag">Vision Agent</span>
            </div>
            <p className="muted">
              Original image validation and provenance are preserved. A
              reference photo does not identify this rack.
            </p>
            <div className="vision-upload" data-testid="vision-upload">
              <div className="vision-controls">
                <label>
                  Inspection photo{" "}
                  <small>JPEG or PNG · max 4 MB · max 4096 px</small>
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
                    onChange={(e) =>
                      setSourceType(e.target.value as ImageSourceType)
                    }
                  >
                    <option value="MANUAL_UPLOAD">Manual upload</option>
                    <option value="ONLINE_REFERENCE">
                      Online reference image
                    </option>
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
                          void run(
                            includeTelemetry ? "COMBINED" : "VISUAL",
                            image,
                          )
                        }
                        disabled={
                          !ready ||
                          !rowsReady ||
                          busy ||
                          runningElsewhere ||
                          !identityReady
                        }
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
          </section>
        )}
        <details className="advanced-settings identity-settings">
          <summary>
            Installed equipment identity <span>Optional</span>
          </summary>
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
              Leave blank when unknown. A generic profile or branding in a
              reference photograph does not establish installed equipment.
              Model-specific guidance requires an exact knowledge-base match.
            </p>
            {!identityReady && (
              <p className="inv-warning">
                Supply both fields and confirm, or clear both fields to
                investigate unidentified equipment.
              </p>
            )}
          </fieldset>
        </details>
      </div>
      <section
        className="panel investigation"
        data-testid="investigation-panel"
        aria-labelledby="investigation-title"
      >
        <div className="panel-heading">
          <h2 id="investigation-title">Latest Investigation</h2>
          <span className="nemotron-label">
            <span className="status-dot" />
            Nemotron
          </span>
        </div>
        {!rowsReady ? (
          <div className="empty-state">
            <Icon name="scan" size={34} />
            <h3>Synchronizing investigations</h3>
            <p>Retrieving this rack’s persisted reports.</p>
          </div>
        ) : !shown ? (
          <div className="empty-state investigation-empty">
            <div className="empty-orbit">
              <Icon name="scan" size={35} />
            </div>
            <span className="eyebrow">Evidence before assumptions</span>
            <h3>A clearer picture starts here.</h3>
            <p>
              No investigation has been recorded for {rack.displayName}. Run
              Nemotron to review the available observations, or attach a photo
              for a visual inspection.
            </p>
            <div className="empty-capabilities">
              <span>Telemetry</span>
              <span>Vision</span>
              <span>Verification</span>
            </div>
          </div>
        ) : (
          <div
            className="inv-body"
            data-testid="investigation-record"
            data-id={shown.investigationId}
            data-status={shown.status}
            data-severity={shown.severity}
          >
            <div className="inv-status-row">
              <span
                className={`inv-badge status-${shown.status.toLowerCase()}`}
              >
                {shown.status}
              </span>
              {shown.status !== "RUNNING" && (
                <span
                  className={`inv-badge sev-${shown.severity.toLowerCase()}`}
                >
                  {shown.severity}
                </span>
              )}
              <span
                className={`review-badge ${reviewPassed(report) ? "review-passed" : ""}`}
                data-testid="verification-status"
              >
                {review}
              </span>
            </div>
            <div className="report-time">
              <Icon name="clock" size={14} />
              <time>{date(shown.createdAt)}</time>
              {shownImage && <span>Photo included</span>}
            </div>
            {shown.status === "RUNNING" ? (
              <div className="running-state">
                <Icon name="scan" size={30} />
                <h3>
                  {abandoned
                    ? "Completion not recorded"
                    : "Investigation in progress"}
                </h3>
                <p>
                  {abandoned
                    ? "This record is still RUNNING in the backend. It may have been interrupted; no completed result is available."
                    : busy
                      ? phase
                      : "A connected session started this investigation. Results will appear when persisted."}
                </p>
                {!abandoned && (
                  <progress aria-label="Investigation in progress" />
                )}
              </div>
            ) : shown.status === "FAILED" ? (
              <div className="failed-state">
                <Icon name="alert" size={28} />
                <h3>Investigation failed</h3>
                <p>
                  {report?.error ??
                    report?.summary ??
                    "No usable investigation result was recorded."}
                </p>
                <small>No completed diagnosis is asserted.</small>
              </div>
            ) : (
              <>
                {shown.status === "INCOMPLETE" && (
                  <p className="inv-warning">
                    Partial investigation. Review execution limits and missing
                    evidence before acting.
                  </p>
                )}
                <div className="main-finding">
                  <span className="eyebrow">Main finding</span>
                  <p className="inv-summary">
                    {report?.summary ||
                      "The saved record has no readable summary."}
                  </p>
                </div>
                <div className="recommended-action">
                  <div className="action-marker">
                    <Icon name="arrow" size={18} />
                  </div>
                  <div>
                    <h3>Recommended action</h3>
                    <p>
                      {report?.recommended_next_inspection?.[0] ??
                        "No recommended action was recorded."}
                    </p>
                  </div>
                </div>
                <div className="report-context">
                  <span className="source-tag">
                    {report?.inspection_mode === "VISUAL"
                      ? "Visual inspection"
                      : shown.telemetrySimulated
                        ? "Simulated telemetry"
                        : "See source provenance"}
                  </span>
                  <p>
                    {shown.profileName} · Configuration at investigation time.
                    AI findings are assessments, not confirmed equipment faults.
                  </p>
                </div>
              </>
            )}
            <details className="investigation-details">
              <summary>
                View Investigation Details
                <Icon name="chevron" size={16} />
              </summary>
              <ReportDetails
                report={report}
                status={shown.status}
                image={shownImage}
                events={events}
              />
              <p className="quiet-note">
                Local demonstration: reports are submitted by the dashboard and
                validated by SpacetimeDB; they are not cryptographically
                attested agent output.
              </p>
            </details>
          </div>
        )}
        {sorted.length > 1 && (
          <details className="investigation-history">
            <summary>
              Previous investigations <span>{sorted.length - 1}</span>
            </summary>
            <label className="inv-history">
              Saved investigation
              <select
                value={historyRow?.investigationId}
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
            <p className="quiet-note">
              The card above always shows the latest investigation. Historical
              records retain their original evidence.
            </p>
            <ReportDetails
              report={detailReport}
              status={historyRow?.status ?? "RUNNING"}
              image={imageRows.find(
                (r) => r.investigationId === historyRow?.investigationId,
              )}
              events={detailEvents}
            />
          </details>
        )}
        <div className="investigation-footer">
          <Icon name="check" size={14} />
          <span>
            Persisted in SpacetimeDB · Shared across connected sessions
          </span>
        </div>
      </section>
    </div>
  );
}

function reviewPassed(report: Partial<AgentReport> | null) {
  const v = report?.verification;
  return Boolean(
    v &&
      v.status === "COMPLETED" &&
      v.grounded &&
      !v.unsupported_claims?.length &&
      !v.contradictions?.length &&
      !v.request_more_investigation,
  );
}
function verificationLabel(report: Partial<AgentReport> | null) {
  const v = report?.verification;
  if (!v) return "Verification not recorded";
  if (v.status === "FAILED") return "Verification failed";
  if (v.status !== "COMPLETED") return "Verification incomplete";
  if (!v.grounded || v.unsupported_claims?.length || v.contradictions?.length)
    return "Review concerns";
  if (v.request_more_investigation) return "Follow-up requested";
  return "AI review passed";
}
function ReportDetails({
  report,
  status,
  image,
  events,
}: {
  report: Partial<AgentReport> | null;
  status: string;
  image?: InvestigationImage;
  events: AgentEvent[];
}) {
  return (
    <div className="report-details-content">
      <div className="agent-roster" aria-label="Agent execution status">
        <span>
          <b>Supervisor</b>
          {report?.supervisor_plan || "No plan recorded"}
        </span>
        {[
          "telemetry",
          "environment",
          "documentation",
          "vision",
          "verification",
        ].map((agent) => {
          const execution = report?.agents_invoked
            ?.filter((r) => r.agent === agent)
            .at(-1);
          return (
            <span key={agent}>
              <b>{agent[0].toUpperCase() + agent.slice(1)} Agent</b>
              {execution?.status ?? "Not invoked"}
            </span>
          );
        })}
      </div>
      {image && <ImageProvenanceView img={image} />}
      {report && report.summary && status !== "FAILED" && (
        <>
          {!!report.visual_findings?.length && (
            <>
              <h3 className="inv-h">
                Visual observations{" "}
                <small>Vision Agent · AI-described, not confirmed faults</small>
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
                    {v.image_location && <small> · {v.image_location}</small>}
                    {v.visual_evidence && (
                      <div className="ev">Evidence: {v.visual_evidence}</div>
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
          {report.evidence && <EquipmentEvidence evidence={report.evidence} />}
          <h3 className="inv-h">
            AI summary <small>hypotheses, not confirmed equipment faults</small>
          </h3>
          <p className="inv-summary">{report.summary}</p>

          <div className="inv-grid">
            <div>
              <h3 className="inv-h">
                Measured facts <small>from tool output, not AI-written</small>
              </h3>
              <ul className="inv-list facts">
                {(report.evidence?.measurements ?? []).map((m, i) => (
                  <li key={i}>
                    <b>{String(m.metric_type)}</b> {String(m.numeric_value)}{" "}
                    {String(m.unit)}{" "}
                    <small>
                      {String(m.source_type)} · {String(m.source_identifier)} ·{" "}
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
                Verification outcome{" "}
                <small>
                  {report.verification
                    ? reviewPassed(report)
                      ? "findings grounded"
                      : "grounding problems found"
                    : "not run"}
                </small>
              </h3>
              <ul className="inv-list">
                {(reviewPassed(report)
                  ? (report.verification?.verified_findings ?? [])
                  : []
                ).map((f, i) => (
                  <li key={`v${i}`}>✓ {f}</li>
                ))}
                {(report.verification?.unsupported_claims ?? []).map((f, i) => (
                  <li key={`u${i}`} className="ev minus">
                    Unsupported: {f}
                  </li>
                ))}
                {(report.verification?.contradictions ?? []).map((f, i) => (
                  <li key={`x${i}`} className="ev minus">
                    Contradiction: {f}
                  </li>
                ))}
                {report.verification?.request_more_investigation && (
                  <li className="ev missing">
                    Requested follow-up: {report.verification.follow_up_agent} —{" "}
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
              {(report.agents_invoked ?? []).map((a) => a.agent).join(" → ") ||
                "none"}
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
            Execution timeline ({events.length} events, recorded during the run)
          </summary>
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
          SpacetimeDB stores this preview and metadata. The original image is
          sent to the configured inference service.
        </small>
      </div>
    </div>
  );
}
