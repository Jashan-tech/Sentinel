import {
  schema,
  table,
  t,
  SenderError,
  ScheduleAt,
  type ReducerCtx,
  type InferSchema,
} from "spacetimedb/server";
import { Identity } from "spacetimedb";
import { validateObservation, evaluate, fairEvictions } from "./rules";
import {
  validateInvestigationStart,
  validateInvestigationCompletion,
  validateInvestigationImage,
  abandonedReport,
  expiredReport,
  isStaleRunning,
  retentionDeletions,
  DEFAULT_RUNNING_TIMEOUT_SECONDS,
  EXPIRY_INTERVAL_SECONDS,
} from "./investigation";

// Scheduled sweep that marks abandoned RUNNING investigations as FAILED (issue 7).
const investigationExpiry = table(
  {},
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() },
);

const observationColumns = {
  observationId: t.u64().primaryKey().autoInc(),
  rackId: t.string().index("btree"),
  metricType: t.string(),
  numericValue: t.f64(),
  unit: t.string(),
  sourceType: t.string(),
  sourceIdentifier: t.string(),
  submittedBy: t.identity(),
  observedAt: t.timestamp(),
  ingestedAt: t.timestamp(),
};
const spacetimedb = schema({
  rackProfile: table(
    { public: true },
    {
      profileId: t.string().primaryKey(),
      name: t.string(),
      description: t.string(),
      equipmentType: t.string(),
      temperatureWarningC: t.f64(),
      temperatureCriticalC: t.f64(),
      humidityWarningPercent: t.f64(),
      createdAt: t.timestamp(),
    },
  ),
  rack: table(
    { public: true },
    {
      rackId: t.string().primaryKey(),
      profileId: t.string().index("btree"),
      displayName: t.string(),
      locationLabel: t.string(),
      createdAt: t.timestamp(),
    },
  ),
  // Full immutable archive is private; ordinary dashboard clients cannot stream it.
  telemetryObservation: table({}, observationColumns),
  recentObservation: table(
    { public: true },
    { ...observationColumns, observationId: t.u64().primaryKey() },
  ),
  currentTelemetry: table(
    { public: true },
    {
      currentKey: t.string().primaryKey(),
      rackId: t.string().index("btree"),
      metricType: t.string(),
      observationId: t.u64(),
      numericValue: t.f64(),
      unit: t.string(),
      sourceType: t.string(),
      sourceIdentifier: t.string(),
      submittedBy: t.identity(),
      observedAt: t.timestamp(),
      ingestedAt: t.timestamp(),
    },
  ),
  rackAlert: table(
    { public: true },
    {
      alertId: t.string().primaryKey(),
      rackId: t.string().index("btree"),
      metricType: t.string(),
      severity: t.string(),
      message: t.string(),
      active: t.bool(),
      createdAt: t.timestamp(),
      resolvedAt: t.option(t.timestamp()),
    },
  ),
  // AI investigation records (Feature 2). Client-submitted; see trust notes in README.
  investigation: table(
    { public: true },
    {
      investigationId: t.string().primaryKey(),
      rackId: t.string().index("btree"),
      profileId: t.string(),
      profileName: t.string(),
      telemetrySimulated: t.bool(),
      status: t.string(),
      severity: t.string(),
      snapshotJson: t.string(),
      reportJson: t.string(),
      eventsJson: t.string(),
      submittedBy: t.identity(),
      createdAt: t.timestamp(),
      completedAt: t.option(t.timestamp()),
    },
  ),
  // ---- Trust (issue 5): private, never streamed to clients ----
  // Database admin: recorded by `init` (the owner) or claimed once via `claim_admin` on older databases.
  adminAccount: table({}, { identity: t.identity().primaryKey(), createdAt: t.timestamp() }),
  // Agent service identities allowed to record investigation reports.
  agentAuthorization: table(
    {},
    {
      identity: t.identity().primaryKey(),
      label: t.string(),
      authorizedBy: t.identity(),
      createdAt: t.timestamp(),
    },
  ),
  // Admin-tunable settings (currently: running_timeout_seconds).
  moduleSetting: table({}, { key: t.string().primaryKey(), value: t.string() }),
  investigationExpiry,
  // Who recorded each terminal state: AGENT, CLIENT_ABANDONED or DATABASE_EXPIRED.
  investigationCompletion: table(
    { public: true },
    {
      investigationId: t.string().primaryKey(),
      rackId: t.string().index("btree"),
      kind: t.string(),
      recordedBy: t.identity(),
      recordedAt: t.timestamp(),
    },
  ),
  // Image provenance for an investigation (Feature 4). Never the full image: hash, metadata
  // and a small preview thumbnail only. The original bytes are not retained anywhere.
  investigationImage: table(
    { public: true },
    {
      investigationId: t.string().primaryKey(),
      rackId: t.string().index("btree"),
      imageId: t.string(),
      filename: t.string(),
      mimeType: t.string(),
      sourceType: t.string(),
      captureTimestamp: t.option(t.timestamp()),
      uploadedAt: t.timestamp(),
      sourceUrl: t.string(),
      attribution: t.string(),
      license: t.string(),
      sha256: t.string(),
      byteSize: t.u32(),
      width: t.u32(),
      height: t.u32(),
      thumbnailDataUrl: t.string(),
      submittedBy: t.identity(),
    },
  ),
});
export default spacetimedb;
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
function seed(ctx: Ctx) {
  const profiles = [
    ["standard", "Standard Network Rack", "Network", 32, 40, 70],
    ["compute", "High-Density Compute Rack", "Compute", 27, 33, 60],
    ["industrial", "Industrial Network Rack", "Industrial", 40, 50, 80],
  ] as const;
  for (const [
    i,
    [id, name, equipmentType, warning, critical, humidity],
  ] of profiles.entries()) {
    if (!ctx.db.rackProfile.profileId.find(id))
      ctx.db.rackProfile.insert({
        profileId: id,
        name,
        description:
          "Fictional demonstration configuration; not manufacturer specifications.",
        equipmentType,
        temperatureWarningC: warning,
        temperatureCriticalC: critical,
        humidityWarningPercent: humidity,
        createdAt: ctx.timestamp,
      });
    const rackId = `rack-${i + 1}`;
    if (!ctx.db.rack.rackId.find(rackId))
      ctx.db.rack.insert({
        rackId,
        profileId: id,
        displayName: `Rack 0${i + 1}`,
        locationLabel: `Demo hall · Row A / Bay 0${i + 1}`,
        createdAt: ctx.timestamp,
      });
  }
}
export const init = spacetimedb.init((ctx) => {
  // The sender of `init` is the database owner: make it the admin.
  if (!ctx.db.adminAccount.identity.find(ctx.sender))
    ctx.db.adminAccount.insert({ identity: ctx.sender, createdAt: ctx.timestamp });
  ensureExpirySchedule(ctx);
  seed(ctx);
});
export const initializeDemo = spacetimedb.reducer(seed);
function reevaluate(ctx: Ctx, rackId: string, metricType: string) {
  const rack = ctx.db.rack.rackId.find(rackId)!;
  const profile = ctx.db.rackProfile.profileId.find(rack.profileId)!;
  const key = `${rackId}:${metricType}`;
  const current = ctx.db.currentTelemetry.currentKey.find(key);
  if (!current) return; // Absence is never evidence of health.
  const result = evaluate(metricType, current.numericValue, profile);
  const existing = ctx.db.rackAlert.alertId.find(key);
  if (result) {
    const row = {
      alertId: key,
      rackId,
      metricType,
      ...result,
      active: true,
      createdAt: existing?.active ? existing.createdAt : ctx.timestamp,
      resolvedAt: undefined,
    };
    if (existing) ctx.db.rackAlert.alertId.update(row);
    else ctx.db.rackAlert.insert(row);
  } else if (existing?.active)
    ctx.db.rackAlert.alertId.update({
      ...existing,
      active: false,
      resolvedAt: ctx.timestamp,
    });
}
export const ingestSimulatedObservation = spacetimedb.reducer(
  {
    rackId: t.string(),
    metricType: t.string(),
    numericValue: t.f64(),
    unit: t.string(),
    sourceType: t.string(),
    sourceIdentifier: t.string(),
    observedAt: t.timestamp(),
  },
  (ctx, args) => {
    if (!ctx.db.rack.rackId.find(args.rackId))
      throw new SenderError("Unknown rack");
    try {
      validateObservation(
        { ...args, observedMicros: args.observedAt.microsSinceUnixEpoch },
        ctx.timestamp.microsSinceUnixEpoch,
      );
    } catch (e) {
      throw new SenderError((e as Error).message);
    }
    const row = ctx.db.telemetryObservation.insert({
      ...args,
      observationId: 0n,
      sourceType: "SIMULATOR",
      submittedBy: ctx.sender,
      ingestedAt: ctx.timestamp,
    });
    ctx.db.recentObservation.insert(row);
    // This indexed scan is bounded to RECENT_LIMIT + 1 rows; archive size never affects ingestion.
    // Fair eviction (issue 9): drop the oldest row of the largest (metric, source) group.
    const recent = [...ctx.db.recentObservation.rackId.filter(args.rackId)].map((r) => ({
      ...r,
      ingestedMicros: r.ingestedAt.microsSinceUnixEpoch,
    }));
    for (const id of fairEvictions(recent)) ctx.db.recentObservation.observationId.delete(id);
    const currentKey = `${args.rackId}:${args.metricType}`;
    const existing = ctx.db.currentTelemetry.currentKey.find(currentKey);
    // First accepted observation wins timestamp ties, avoiding source races.
    if (
      !existing ||
      args.observedAt.microsSinceUnixEpoch >
        existing.observedAt.microsSinceUnixEpoch
    ) {
      const current = { ...row, currentKey };
      if (existing) ctx.db.currentTelemetry.currentKey.update(current);
      else ctx.db.currentTelemetry.insert(current);
      reevaluate(ctx, args.rackId, args.metricType);
    }
  },
);
export const changeRackProfile = spacetimedb.reducer(
  { rackId: t.string(), profileId: t.string() },
  (ctx, { rackId, profileId }) => {
    const rack = ctx.db.rack.rackId.find(rackId);
    if (!rack) throw new SenderError("Unknown rack");
    if (!ctx.db.rackProfile.profileId.find(profileId))
      throw new SenderError("Unknown rack profile");
    ctx.db.rack.rackId.update({ ...rack, profileId });
    for (const current of ctx.db.currentTelemetry.rackId.filter(rackId))
      reevaluate(ctx, rackId, current.metricType);
  },
);

// ---- AI investigation records ----
// One row per investigation. Terminal rows are never overwritten; the newest
// MAX_INVESTIGATIONS_PER_RACK per rack are retained (bounded subscriptions, issue 10).

const isAdmin = (ctx: Ctx, who: Identity) => Boolean(ctx.db.adminAccount.identity.find(who));
const isAuthorizedAgent = (ctx: Ctx, who: Identity) => Boolean(ctx.db.agentAuthorization.identity.find(who));
function runningTimeoutSeconds(ctx: Ctx) {
  const v = Number(ctx.db.moduleSetting.key.find("running_timeout_seconds")?.value);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_RUNNING_TIMEOUT_SECONDS;
}
function ensureExpirySchedule(ctx: Ctx) {
  if (ctx.db.investigationExpiry.count() === 0n)
    ctx.db.investigationExpiry.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.interval(BigInt(EXPIRY_INTERVAL_SECONDS) * 1_000_000n),
    });
}
function recordTerminal(ctx: Ctx, row: { investigationId: string; rackId: string }, kind: string) {
  if (!ctx.db.investigationCompletion.investigationId.find(row.investigationId))
    ctx.db.investigationCompletion.insert({
      investigationId: row.investigationId,
      rackId: row.rackId,
      kind,
      recordedBy: ctx.sender,
      recordedAt: ctx.timestamp,
    });
}
/** Mark stale RUNNING rows FAILED. Durable recovery for interrupted browsers or agents. */
function expireStale(ctx: Ctx, rows: Iterable<Investigation>) {
  const timeout = runningTimeoutSeconds(ctx);
  for (const row of rows)
    if (isStaleRunning({ status: row.status, createdMicros: row.createdAt.microsSinceUnixEpoch }, ctx.timestamp.microsSinceUnixEpoch, timeout)) {
      ctx.db.investigation.investigationId.update({
        ...row,
        status: "FAILED",
        severity: "UNKNOWN",
        reportJson: expiredReport(timeout),
        completedAt: ctx.timestamp,
      });
      recordTerminal(ctx, row, "DATABASE_EXPIRED");
    }
}
type Investigation = ReturnType<Ctx["db"]["investigation"]["iter"]> extends Iterable<infer R> ? R : never;
function deleteInvestigation(ctx: Ctx, id: string) {
  ctx.db.investigation.investigationId.delete(id);
  ctx.db.investigationImage.investigationId.delete(id);
  ctx.db.investigationCompletion.investigationId.delete(id);
}

export const claimAdmin = spacetimedb.reducer((ctx) => {
  if (isAdmin(ctx, ctx.sender)) return; // idempotent
  if (ctx.db.adminAccount.count() > 0n) throw new SenderError("This database already has an admin");
  ctx.db.adminAccount.insert({ identity: ctx.sender, createdAt: ctx.timestamp });
  ensureExpirySchedule(ctx);
});
export const authorizeAgent = spacetimedb.reducer(
  { agentIdentity: t.string(), label: t.string() },
  (ctx, { agentIdentity, label }) => {
    if (!isAdmin(ctx, ctx.sender)) throw new SenderError("Only the database admin can authorize an agent");
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(agentIdentity)) throw new SenderError("agentIdentity must be a 64-character hex identity");
    const identity = Identity.fromString(agentIdentity.replace(/^0x/, "").toLowerCase());
    const row = { identity, label: label.trim().slice(0, 100) || "agent", authorizedBy: ctx.sender, createdAt: ctx.timestamp };
    if (ctx.db.agentAuthorization.identity.find(identity)) ctx.db.agentAuthorization.identity.update(row);
    else ctx.db.agentAuthorization.insert(row);
    ensureExpirySchedule(ctx);
  },
);
export const revokeAgent = spacetimedb.reducer({ agentIdentity: t.string() }, (ctx, { agentIdentity }) => {
  if (!isAdmin(ctx, ctx.sender)) throw new SenderError("Only the database admin can revoke an agent");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(agentIdentity)) throw new SenderError("agentIdentity must be a 64-character hex identity");
  ctx.db.agentAuthorization.identity.delete(Identity.fromString(agentIdentity.replace(/^0x/, "").toLowerCase()));
});
export const setRunningTimeout = spacetimedb.reducer({ seconds: t.u32() }, (ctx, { seconds }) => {
  if (!isAdmin(ctx, ctx.sender)) throw new SenderError("Only the database admin can change settings");
  if (seconds < 1 || seconds > 3600) throw new SenderError("Timeout must be 1-3600 seconds");
  const row = { key: "running_timeout_seconds", value: String(seconds) };
  if (ctx.db.moduleSetting.key.find(row.key)) ctx.db.moduleSetting.key.update(row);
  else ctx.db.moduleSetting.insert(row);
});

export const startInvestigation = spacetimedb.reducer(
  { investigationId: t.string(), rackId: t.string(), snapshotJson: t.string() },
  (ctx, args) => {
    const rack = ctx.db.rack.rackId.find(args.rackId);
    if (!rack) throw new SenderError("Unknown rack");
    if (ctx.db.investigation.investigationId.find(args.investigationId))
      throw new SenderError("Investigation ID already exists");
    try {
      validateInvestigationStart(args);
    } catch (e) {
      throw new SenderError((e as Error).message);
    }
    ensureExpirySchedule(ctx);
    const existing = [...ctx.db.investigation.rackId.filter(args.rackId)];
    expireStale(ctx, existing); // opportunistic recovery for this rack
    const profile = ctx.db.rackProfile.profileId.find(rack.profileId)!;
    // Provenance is derived server-side from stored telemetry, not taken from the client.
    const telemetrySimulated = [...ctx.db.currentTelemetry.rackId.filter(args.rackId)].every(
      (c) => c.sourceType === "SIMULATOR",
    );
    ctx.db.investigation.insert({
      investigationId: args.investigationId,
      rackId: args.rackId,
      profileId: profile.profileId,
      profileName: profile.name,
      telemetrySimulated,
      status: "RUNNING",
      severity: "UNKNOWN",
      snapshotJson: args.snapshotJson,
      reportJson: "{}",
      eventsJson: "[]",
      submittedBy: ctx.sender,
      createdAt: ctx.timestamp,
      completedAt: undefined,
    });
    // Retention (issue 10): keep the newest investigations per rack; never delete RUNNING rows.
    const rows = [...ctx.db.investigation.rackId.filter(args.rackId)].map((r) => ({
      id: r.investigationId,
      status: r.status,
      createdMicros: r.createdAt.microsSinceUnixEpoch,
    }));
    for (const id of retentionDeletions(rows)) deleteInvestigation(ctx, id);
  },
);

/** Only an authorized agent identity can record a report (issue 5). Identical retries are no-ops. */
export const completeInvestigation = spacetimedb.reducer(
  {
    investigationId: t.string(),
    status: t.string(),
    severity: t.string(),
    reportJson: t.string(),
    eventsJson: t.string(),
  },
  (ctx, args) => {
    if (!isAuthorizedAgent(ctx, ctx.sender))
      throw new SenderError("Only an authorized agent service can record investigation reports");
    const row = ctx.db.investigation.investigationId.find(args.investigationId);
    if (!row) throw new SenderError("Unknown investigation");
    if (row.status !== "RUNNING") {
      const done = ctx.db.investigationCompletion.investigationId.find(args.investigationId);
      const same =
        row.status === args.status &&
        row.severity === args.severity &&
        row.reportJson === args.reportJson &&
        row.eventsJson === args.eventsJson;
      if (same && done?.kind === "AGENT") return; // idempotent retry
      throw new SenderError(`Investigation is already ${row.status}${done ? ` (${done.kind})` : ""}`);
    }
    try {
      validateInvestigationCompletion(args, row.rackId);
    } catch (e) {
      throw new SenderError((e as Error).message);
    }
    ctx.db.investigation.investigationId.update({
      ...row,
      status: args.status,
      severity: args.severity,
      reportJson: args.reportJson,
      eventsJson: args.eventsJson,
      completedAt: ctx.timestamp,
    });
    recordTerminal(ctx, row, "AGENT");
  },
);

/** The starting browser may give up on its own run: FAILED, UNKNOWN, no diagnosis. Idempotent. */
export const abandonInvestigation = spacetimedb.reducer(
  { investigationId: t.string(), reason: t.string() },
  (ctx, { investigationId, reason }) => {
    const row = ctx.db.investigation.investigationId.find(investigationId);
    if (!row) throw new SenderError("Unknown investigation");
    if (!row.submittedBy.isEqual(ctx.sender))
      throw new SenderError("Only the identity that started an investigation can abandon it");
    if (row.status !== "RUNNING") return; // already terminal: nothing to do
    ctx.db.investigation.investigationId.update({
      ...row,
      status: "FAILED",
      severity: "UNKNOWN",
      reportJson: abandonedReport(reason),
      completedAt: ctx.timestamp,
    });
    recordTerminal(ctx, row, "CLIENT_ABANDONED");
  },
);

export const expireStaleInvestigations = spacetimedb.reducer(
  { onSchedule: investigationExpiry },
  { arg: investigationExpiry.rowType },
  (ctx) => {
    if (!ctx.senderAuth.isInternal) throw new SenderError("Scheduled reducer");
    expireStale(ctx, [...ctx.db.investigation.iter()]);
  },
);

export const attachInvestigationImage = spacetimedb.reducer(
  {
    investigationId: t.string(),
    imageId: t.string(),
    filename: t.string(),
    mimeType: t.string(),
    sourceType: t.string(),
    captureTimestamp: t.option(t.timestamp()),
    sourceUrl: t.string(),
    attribution: t.string(),
    license: t.string(),
    sha256: t.string(),
    byteSize: t.u32(),
    width: t.u32(),
    height: t.u32(),
    thumbnailDataUrl: t.string(),
  },
  (ctx, args) => {
    const inv = ctx.db.investigation.investigationId.find(args.investigationId);
    if (!inv) throw new SenderError("Unknown investigation");
    if (!inv.submittedBy.isEqual(ctx.sender))
      throw new SenderError("Only the identity that started an investigation can attach its image");
    if (inv.status !== "RUNNING") throw new SenderError("Images can only be attached while the investigation is running");
    if (ctx.db.investigationImage.investigationId.find(args.investigationId))
      throw new SenderError("This investigation already has an image");
    if (
      args.captureTimestamp &&
      args.captureTimestamp.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch + 30_000_000n
    )
      throw new SenderError("Capture timestamp cannot be in the future");
    try {
      validateInvestigationImage(args);
    } catch (e) {
      throw new SenderError((e as Error).message);
    }
    ctx.db.investigationImage.insert({
      ...args,
      captureTimestamp: args.captureTimestamp ?? undefined, // unknown stays unknown
      rackId: inv.rackId,
      uploadedAt: ctx.timestamp, // server time, not client-supplied
      submittedBy: ctx.sender,
    });
  },
);
