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
import {
  validateRunRequest,
  canTransition,
  isAbandonedRun,
  validateBenchValue,
  runRetention,
  validMeasurement,
  rampStages,
  ACTIVE_STATES,
  type BenchState,
} from "./benchmark";
import { validateObservation, evaluate, fairEvictions } from "./rules";
import { catalogEntry, documentedThresholds } from "./equipmentCatalog";
import {
  validateInvestigationStart,
  validateInvestigationCompletion,
  validateInvestigationImage,
  validateProgress,
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
  // Installed server per rack, chosen by the operator from the sourced catalog (equipmentCatalog.ts).
  rackEquipment: table(
    { public: true },
    { rackId: t.string().primaryKey(), modelId: t.string(), assignedBy: t.identity(), assignedAt: t.timestamp() },
  ),
  // Provenance of profiles whose thresholds come from a manufacturer's documented range
  // (profiles without a row here are fictional demonstration settings).
  rackProfileSource: table(
    { public: true },
    {
      profileId: t.string().primaryKey(),
      modelId: t.string(),
      docId: t.string(),
      sourceTitle: t.string(),
      sourceUrl: t.string(),
      section: t.string(),
      accessDate: t.string(),
      mapping: t.string(),
    },
  ),
  // Live progress of a RUNNING investigation, written only by the authorized agent and deleted
  // when the run reaches a terminal state. Descriptive only: which agent is working, never a finding.
  investigationProgress: table(
    { public: true },
    {
      investigationId: t.string().primaryKey(),
      rackId: t.string().index("btree"),
      phase: t.string(),
      stepsJson: t.string(),
      updatedAt: t.timestamp(),
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
  // ---- Fleet benchmark (isolated from rack telemetry and investigations) ----
  // Identities allowed to run the external load generator. Private; admin-managed.
  benchmarkRunnerAuthorization: table(
    {},
    { identity: t.identity().primaryKey(), label: t.string(), authorizedBy: t.identity(), createdAt: t.timestamp() },
  ),
  // Live runner connections (one row per registered control connection; removed on disconnect).
  benchmarkRunner: table(
    { public: true },
    { connectionKey: t.string().primaryKey(), label: t.string(), connectedAt: t.timestamp() },
  ),
  benchmarkRun: table(
    { public: true },
    {
      runId: t.u32().primaryKey().autoInc(),
      mode: t.string(),
      state: t.string(),
      roverCount: t.u32(),
      eventsPerRoverPerSecond: t.u32(),
      durationSeconds: t.u32(),
      subscriberCount: t.u32(),
      requestedBy: t.identity(),
      requestedAt: t.timestamp(),
      startedAt: t.option(t.timestamp()),
      finishedAt: t.option(t.timestamp()),
      runnerConnection: t.string(),
      runnerIdentity: t.option(t.identity()),
      currentStage: t.u32(),
      stageCount: t.u32(),
      message: t.string(),
      environmentJson: t.string(),
    },
  ),
  // Per-stage results measured by the load generator (one row per completed stage).
  benchmarkStage: table(
    { public: true },
    {
      stageKey: t.string().primaryKey(),
      runId: t.u32().index("btree"),
      stageIndex: t.u32(),
      roverCount: t.u32(),
      targetRate: t.f64(),
      startedElapsedMs: t.f64(),
      endedElapsedMs: t.f64(),
      sendWindowMs: t.f64(),
      attempted: t.u64(),
      acknowledged: t.u64(),
      rejected: t.u64(),
      transportErrors: t.u64(),
      unresolved: t.u64(),
      notSentBackpressure: t.u64(),
      observedPairs: t.u64(),
      expectedPairs: t.u64(),
      duplicateObservations: t.u64(),
      achievedRate: t.option(t.f64()),
      ackP50: t.option(t.f64()),
      ackP95: t.option(t.f64()),
      ackP99: t.option(t.f64()),
      ackSamples: t.u32(),
      deliveryP50: t.option(t.f64()),
      deliveryP95: t.option(t.f64()),
      deliveryP99: t.option(t.f64()),
      deliverySamples: t.u32(),
      eventLoopP99Ms: t.option(t.f64()),
      reportedAt: t.timestamp(),
    },
  ),
  // Independent server-side evidence per stage: the change in SpacetimeDB's own transaction
  // counters for bench_write (from its /v1/metrics endpoint), absent when unavailable.
  benchmarkStageServer: table(
    { public: true },
    {
      stageKey: t.string().primaryKey(),
      runId: t.u32().index("btree"),
      committedTxns: t.option(t.u64()),
      failedTxns: t.option(t.u64()),
      source: t.string(),
    },
  ),
  // One row per measurement window (~1 s) while a run is in progress.
  benchmarkSample: table(
    { public: true },
    {
      sampleId: t.u64().primaryKey().autoInc(),
      runId: t.u32().index("btree"),
      stageIndex: t.u32(),
      elapsedMs: t.f64(),
      windowMs: t.f64(),
      activeRovers: t.u32(),
      activeSubscribers: t.u32(),
      targetRate: t.f64(),
      windowAcknowledged: t.u32(),
      achievedRate: t.option(t.f64()),
      deliveryP95: t.option(t.f64()),
      deliverySamples: t.u32(),
      ackP95: t.option(t.f64()),
      totalAttempted: t.u64(),
      totalAcknowledged: t.u64(),
      totalRejected: t.u64(),
      totalTransportErrors: t.u64(),
      totalObservedPairs: t.u64(),
      inFlight: t.u32(),
    },
  ),
  // Append-only SIMULATED event stream. An event table: rows are delivered to subscribers in the
  // transaction that inserts them and are not retained, so benchmark load never grows storage.
  benchmarkEvent: table(
    { public: true, event: true },
    {
      runId: t.u32(),
      eventNo: t.u32(),
      roverIndex: t.u32(),
      roverSeq: t.u32(),
      simulatedValue: t.f64(),
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
  const documented = Boolean(ctx.db.rackProfileSource.profileId.find(profile.profileId));
  const result = evaluate(metricType, current.numericValue, profile, documented ? "manufacturer-documented" : "demonstration");
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
    const source = ctx.db.rackProfileSource.profileId.find(profileId);
    if (source && ctx.db.rackEquipment.rackId.find(rackId)?.modelId !== source.modelId)
      throw new SenderError("A documented-range profile can only be used on a rack with that server assigned");
    ctx.db.rack.rackId.update({ ...rack, profileId });
    for (const current of ctx.db.currentTelemetry.rackId.filter(rackId))
      reevaluate(ctx, rackId, current.metricType);
  },
);

// ---- Installed equipment (operator-assigned, from the sourced catalog) ----
function setRackProfile(ctx: Ctx, rackId: string, profileId: string) {
  const rack = ctx.db.rack.rackId.find(rackId)!;
  ctx.db.rack.rackId.update({ ...rack, profileId });
  for (const current of ctx.db.currentTelemetry.rackId.filter(rackId)) reevaluate(ctx, rackId, current.metricType);
}

/** Assign (or clear, with modelId "") the server installed in a rack. */
export const assignRackEquipment = spacetimedb.reducer(
  { rackId: t.string(), modelId: t.string() },
  (ctx, { rackId, modelId }) => {
    const rack = ctx.db.rack.rackId.find(rackId);
    if (!rack) throw new SenderError("Unknown rack");
    if (modelId && !catalogEntry(modelId)) throw new SenderError("Unknown server model; choose one from the catalog");
    const existing = ctx.db.rackEquipment.rackId.find(rackId);
    if (!modelId) ctx.db.rackEquipment.rackId.delete(rackId);
    else {
      const row = { rackId, modelId, assignedBy: ctx.sender, assignedAt: ctx.timestamp };
      if (existing) ctx.db.rackEquipment.rackId.update(row);
      else ctx.db.rackEquipment.insert(row);
    }
    // Thresholds documented for a different server must not stay on this rack.
    const source = ctx.db.rackProfileSource.profileId.find(rack.profileId);
    if (source && source.modelId !== modelId) setRackProfile(ctx, rackId, "standard");
  },
);

/** Opt-in: create (or refresh) the sourced profile for the rack's server and apply it to the rack. */
export const applyDocumentedThresholds = spacetimedb.reducer({ rackId: t.string() }, (ctx, { rackId }) => {
  if (!ctx.db.rack.rackId.find(rackId)) throw new SenderError("Unknown rack");
  const assigned = ctx.db.rackEquipment.rackId.find(rackId);
  if (!assigned) throw new SenderError("Assign the installed server first");
  const entry = catalogEntry(assigned.modelId);
  if (!entry) throw new SenderError("Unknown server model");
  const d = documentedThresholds(entry);
  const profile = {
    profileId: d.profileId,
    name: d.name,
    description: `Manufacturer-documented range from ${entry.source.title} (${entry.source.section}). ${d.mapping} Documented for server inlet air at ≤ 900 m / sea level; rover ambient air is not inlet temperature.`,
    equipmentType: entry.equipmentType,
    temperatureWarningC: d.temperatureWarningC,
    temperatureCriticalC: d.temperatureCriticalC,
    humidityWarningPercent: d.humidityWarningPercent,
    createdAt: ctx.timestamp,
  };
  if (ctx.db.rackProfile.profileId.find(d.profileId)) ctx.db.rackProfile.profileId.update(profile);
  else ctx.db.rackProfile.insert(profile);
  const source = {
    profileId: d.profileId,
    modelId: entry.modelId,
    docId: entry.docId,
    sourceTitle: entry.source.title,
    sourceUrl: entry.source.url,
    section: entry.source.section,
    accessDate: entry.source.accessDate,
    mapping: d.mapping,
  };
  if (ctx.db.rackProfileSource.profileId.find(d.profileId)) ctx.db.rackProfileSource.profileId.update(source);
  else ctx.db.rackProfileSource.insert(source);
  setRackProfile(ctx, rackId, d.profileId);
});

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
  ctx.db.investigationProgress.investigationId.delete(row.investigationId); // progress ends with the run
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
  ctx.db.investigationProgress.investigationId.delete(id);
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

/** Live progress from the authorized agent while a run is RUNNING. Ignored once the run is terminal. */
export const recordInvestigationProgress = spacetimedb.reducer(
  { investigationId: t.string(), phase: t.string(), stepsJson: t.string() },
  (ctx, { investigationId, phase, stepsJson }) => {
    if (!isAuthorizedAgent(ctx, ctx.sender))
      throw new SenderError("Only an authorized agent service can record investigation progress");
    const row = ctx.db.investigation.investigationId.find(investigationId);
    if (!row) throw new SenderError("Unknown investigation");
    if (row.status !== "RUNNING") return; // a late update must not resurrect progress for a finished run
    try {
      validateProgress(phase, stepsJson);
    } catch (e) {
      throw new SenderError((e as Error).message);
    }
    const next = { investigationId, rackId: row.rackId, phase, stepsJson, updatedAt: ctx.timestamp };
    if (ctx.db.investigationProgress.investigationId.find(investigationId)) ctx.db.investigationProgress.investigationId.update(next);
    else ctx.db.investigationProgress.insert(next);
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

// ---- Fleet benchmark ----
// The database validates, isolates and stores. All performance numbers come from the external
// load generator's own instrumentation (scripts in benchmark/); none are produced here.

type BenchRun = ReturnType<Ctx["db"]["benchmarkRun"]["iter"]> extends Iterable<infer R> ? R : never;
const connectionKey = (ctx: Ctx) => ctx.connectionId?.toHexString() ?? "";
const isBenchmarkRunner = (ctx: Ctx) => Boolean(ctx.db.benchmarkRunnerAuthorization.identity.find(ctx.sender));
const parseIdentity = (hex: string) => {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new SenderError("Identity must be a 64-character hex identity");
  return Identity.fromString(hex.replace(/^0x/, "").toLowerCase());
};
function setRunState(ctx: Ctx, run: BenchRun, state: BenchState, message: string) {
  if (!canTransition(run.state, state)) throw new SenderError(`Run ${run.runId} cannot go from ${run.state} to ${state}`);
  const terminal = !ACTIVE_STATES.includes(state);
  ctx.db.benchmarkRun.runId.update({
    ...run,
    state,
    message: message.slice(0, 500),
    finishedAt: terminal ? ctx.timestamp : run.finishedAt,
  });
}
function failAbandonedRuns(ctx: Ctx) {
  for (const run of [...ctx.db.benchmarkRun.iter()]) {
    const reason = isAbandonedRun(
      {
        state: run.state,
        requestedMicros: run.requestedAt.microsSinceUnixEpoch,
        startedMicros: run.startedAt?.microsSinceUnixEpoch ?? null,
      },
      ctx.timestamp.microsSinceUnixEpoch,
    );
    if (reason) setRunState(ctx, run, "FAILED", reason);
  }
}
function deleteRun(ctx: Ctx, runId: number) {
  for (const s of [...ctx.db.benchmarkStage.runId.filter(runId)]) ctx.db.benchmarkStage.stageKey.delete(s.stageKey);
  for (const s of [...ctx.db.benchmarkSample.runId.filter(runId)]) ctx.db.benchmarkSample.sampleId.delete(s.sampleId);
  for (const s of [...ctx.db.benchmarkStageServer.runId.filter(runId)]) ctx.db.benchmarkStageServer.stageKey.delete(s.stageKey);
  ctx.db.benchmarkRun.runId.delete(runId);
}
/** The calling connection must be the registered runner that claimed this run. */
function requireRunOwner(ctx: Ctx, runId: number): BenchRun {
  const run = ctx.db.benchmarkRun.runId.find(runId);
  if (!run) throw new SenderError("Unknown benchmark run");
  if (!run.runnerIdentity || !run.runnerIdentity.isEqual(ctx.sender))
    throw new SenderError("Only the runner that claimed this benchmark run can report for it");
  return run;
}
function checkMeasurements(values: (number | undefined)[]) {
  for (const v of values) if (!validMeasurement(v)) throw new SenderError("Measurements must be finite, non-negative or absent");
}

export const authorizeBenchmarkRunner = spacetimedb.reducer(
  { runnerIdentity: t.string(), label: t.string() },
  (ctx, { runnerIdentity, label }) => {
    if (!isAdmin(ctx, ctx.sender)) throw new SenderError("Only the database admin can authorize a benchmark runner");
    const identity = parseIdentity(runnerIdentity);
    const row = { identity, label: label.trim().slice(0, 100) || "benchmark-runner", authorizedBy: ctx.sender, createdAt: ctx.timestamp };
    if (ctx.db.benchmarkRunnerAuthorization.identity.find(identity)) ctx.db.benchmarkRunnerAuthorization.identity.update(row);
    else ctx.db.benchmarkRunnerAuthorization.insert(row);
  },
);

export const registerBenchmarkRunner = spacetimedb.reducer({ label: t.string() }, (ctx, { label }) => {
  if (!isBenchmarkRunner(ctx)) throw new SenderError("This identity is not an authorized benchmark runner");
  const key = connectionKey(ctx);
  if (!key) throw new SenderError("A live connection is required");
  const row = { connectionKey: key, label: label.trim().slice(0, 100) || "benchmark-runner", connectedAt: ctx.timestamp };
  if (ctx.db.benchmarkRunner.connectionKey.find(key)) ctx.db.benchmarkRunner.connectionKey.update(row);
  else ctx.db.benchmarkRunner.insert(row);
});

export const onClientDisconnected = spacetimedb.clientDisconnected((ctx) => {
  const key = connectionKey(ctx);
  if (!key || !ctx.db.benchmarkRunner.connectionKey.find(key)) return;
  ctx.db.benchmarkRunner.connectionKey.delete(key);
  for (const run of [...ctx.db.benchmarkRun.iter()])
    if (run.runnerConnection === key && ACTIVE_STATES.includes(run.state as BenchState))
      setRunState(ctx, run, "FAILED", "The benchmark runner disconnected before finishing; partial results are kept");
});

export const requestBenchmarkRun = spacetimedb.reducer(
  {
    mode: t.string(),
    roverCount: t.u32(),
    eventsPerRoverPerSecond: t.u32(),
    durationSeconds: t.u32(),
    subscriberCount: t.u32(),
  },
  (ctx, args) => {
    try {
      validateRunRequest(args);
    } catch (e) {
      throw new SenderError((e as Error).message);
    }
    failAbandonedRuns(ctx);
    const active = [...ctx.db.benchmarkRun.iter()].find((r) => ACTIVE_STATES.includes(r.state as BenchState));
    if (active) throw new SenderError(`Benchmark run ${active.runId} is still ${active.state}; one run at a time`);
    if (ctx.db.benchmarkRunner.count() === 0n)
      throw new SenderError("No benchmark runner is connected. Start one with: npm run bench:runner");
    ctx.db.benchmarkRun.insert({
      runId: 0,
      ...args,
      state: "REQUESTED",
      requestedBy: ctx.sender,
      requestedAt: ctx.timestamp,
      startedAt: undefined,
      finishedAt: undefined,
      runnerConnection: "",
      runnerIdentity: undefined,
      currentStage: 0,
      stageCount: args.mode === "RAMP" ? rampStages(args.roverCount).length : 1,
      message: "",
      environmentJson: "{}",
    });
    const runs = [...ctx.db.benchmarkRun.iter()].map((r) => ({ runId: r.runId, state: r.state }));
    for (const id of runRetention(runs)) deleteRun(ctx, id);
  },
);

export const claimBenchmarkRun = spacetimedb.reducer(
  { runId: t.u32(), environmentJson: t.string() },
  (ctx, { runId, environmentJson }) => {
    if (!isBenchmarkRunner(ctx)) throw new SenderError("This identity is not an authorized benchmark runner");
    const key = connectionKey(ctx);
    if (!ctx.db.benchmarkRunner.connectionKey.find(key)) throw new SenderError("Register this connection as a runner first");
    const run = ctx.db.benchmarkRun.runId.find(runId);
    if (!run) throw new SenderError("Unknown benchmark run");
    if (run.state !== "REQUESTED") throw new SenderError(`Run ${runId} is ${run.state}, not REQUESTED`);
    ctx.db.benchmarkRun.runId.update({
      ...run,
      state: "RUNNING",
      startedAt: ctx.timestamp,
      runnerConnection: key,
      runnerIdentity: ctx.sender,
      environmentJson: environmentJson.slice(0, 2000),
    });
  },
);

/** Anyone viewing the dashboard may stop the active run. Idempotent. */
export const stopBenchmarkRun = spacetimedb.reducer({ runId: t.u32() }, (ctx, { runId }) => {
  const run = ctx.db.benchmarkRun.runId.find(runId);
  if (!run) throw new SenderError("Unknown benchmark run");
  if (run.state === "REQUESTED") setRunState(ctx, run, "STOPPED", "Stopped before a runner started it");
  else if (run.state === "RUNNING") setRunState(ctx, run, "STOP_REQUESTED", "Stop requested");
});

/** The benchmark write path: one SIMULATED event per call, delivered to subscribers, not stored. */
export const benchWrite = spacetimedb.reducer(
  { runId: t.u32(), eventNo: t.u32(), roverIndex: t.u32(), roverSeq: t.u32(), simulatedValue: t.f64() },
  (ctx, args) => {
    const run = ctx.db.benchmarkRun.runId.find(args.runId);
    if (!run) throw new SenderError("Unknown benchmark run");
    if (!run.runnerIdentity || !run.runnerIdentity.isEqual(ctx.sender))
      throw new SenderError("Only the runner that claimed this benchmark run can write to it");
    if (run.state !== "RUNNING" && run.state !== "STOP_REQUESTED")
      throw new SenderError(`Benchmark run ${run.runId} is ${run.state}; writes are closed`);
    if (args.roverIndex >= run.roverCount) throw new SenderError("Rover index outside this run's fleet");
    try {
      validateBenchValue(args.simulatedValue);
    } catch (e) {
      throw new SenderError((e as Error).message);
    }
    ctx.db.benchmarkEvent.insert(args);
  },
);

export const reportBenchmarkSample = spacetimedb.reducer(
  {
    runId: t.u32(),
    stageIndex: t.u32(),
    elapsedMs: t.f64(),
    windowMs: t.f64(),
    activeRovers: t.u32(),
    activeSubscribers: t.u32(),
    targetRate: t.f64(),
    windowAcknowledged: t.u32(),
    achievedRate: t.option(t.f64()),
    deliveryP95: t.option(t.f64()),
    deliverySamples: t.u32(),
    ackP95: t.option(t.f64()),
    totalAttempted: t.u64(),
    totalAcknowledged: t.u64(),
    totalRejected: t.u64(),
    totalTransportErrors: t.u64(),
    totalObservedPairs: t.u64(),
    inFlight: t.u32(),
  },
  (ctx, args) => {
    const run = requireRunOwner(ctx, args.runId);
    if (!ACTIVE_STATES.includes(run.state as BenchState)) throw new SenderError(`Run ${run.runId} is ${run.state}`);
    checkMeasurements([args.elapsedMs, args.windowMs, args.targetRate, args.achievedRate, args.deliveryP95, args.ackP95]);
    if (args.totalAcknowledged > args.totalAttempted) throw new SenderError("Acknowledged cannot exceed attempted");
    ctx.db.benchmarkSample.insert({
      sampleId: 0n,
      ...args,
      achievedRate: args.achievedRate ?? undefined, // unmeasured stays absent
      deliveryP95: args.deliveryP95 ?? undefined,
      ackP95: args.ackP95 ?? undefined,
    });
    if (run.currentStage !== args.stageIndex) ctx.db.benchmarkRun.runId.update({ ...run, currentStage: args.stageIndex });
  },
);

export const reportBenchmarkStage = spacetimedb.reducer(
  {
    runId: t.u32(),
    stageIndex: t.u32(),
    roverCount: t.u32(),
    targetRate: t.f64(),
    startedElapsedMs: t.f64(),
    endedElapsedMs: t.f64(),
    sendWindowMs: t.f64(),
    attempted: t.u64(),
    acknowledged: t.u64(),
    rejected: t.u64(),
    transportErrors: t.u64(),
    unresolved: t.u64(),
    notSentBackpressure: t.u64(),
    observedPairs: t.u64(),
    expectedPairs: t.u64(),
    duplicateObservations: t.u64(),
    achievedRate: t.option(t.f64()),
    ackP50: t.option(t.f64()),
    ackP95: t.option(t.f64()),
    ackP99: t.option(t.f64()),
    ackSamples: t.u32(),
    deliveryP50: t.option(t.f64()),
    deliveryP95: t.option(t.f64()),
    deliveryP99: t.option(t.f64()),
    deliverySamples: t.u32(),
    eventLoopP99Ms: t.option(t.f64()),
    serverCommitted: t.option(t.u64()),
    serverFailed: t.option(t.u64()),
    serverSource: t.string(),
  },
  (ctx, { serverCommitted, serverFailed, serverSource, ...args }) => {
    const run = requireRunOwner(ctx, args.runId);
    if (!ACTIVE_STATES.includes(run.state as BenchState)) throw new SenderError(`Run ${run.runId} is ${run.state}`);
    if (args.stageIndex >= run.stageCount) throw new SenderError("Stage index outside this run");
    checkMeasurements([
      args.targetRate, args.startedElapsedMs, args.endedElapsedMs, args.sendWindowMs, args.achievedRate,
      args.ackP50, args.ackP95, args.ackP99, args.deliveryP50, args.deliveryP95, args.deliveryP99, args.eventLoopP99Ms,
    ]);
    if (args.acknowledged + args.rejected + args.transportErrors + args.unresolved !== args.attempted)
      throw new SenderError("Stage outcomes must add up to attempted writes");
    if (args.observedPairs > args.expectedPairs) throw new SenderError("Observed deliveries cannot exceed expected deliveries");
    const stageKey = `${args.runId}:${args.stageIndex}`;
    const row = {
      stageKey,
      ...args,
      achievedRate: args.achievedRate ?? undefined, // unmeasured stays absent
      ackP50: args.ackP50 ?? undefined,
      ackP95: args.ackP95 ?? undefined,
      ackP99: args.ackP99 ?? undefined,
      deliveryP50: args.deliveryP50 ?? undefined,
      deliveryP95: args.deliveryP95 ?? undefined,
      deliveryP99: args.deliveryP99 ?? undefined,
      eventLoopP99Ms: args.eventLoopP99Ms ?? undefined,
      reportedAt: ctx.timestamp,
    };
    if (ctx.db.benchmarkStage.stageKey.find(stageKey)) ctx.db.benchmarkStage.stageKey.update(row);
    else ctx.db.benchmarkStage.insert(row);
    const server = {
      stageKey,
      runId: args.runId,
      committedTxns: serverCommitted ?? undefined,
      failedTxns: serverFailed ?? undefined,
      source: serverSource.slice(0, 200),
    };
    if (ctx.db.benchmarkStageServer.stageKey.find(stageKey)) ctx.db.benchmarkStageServer.stageKey.update(server);
    else ctx.db.benchmarkStageServer.insert(server);
  },
);

export const finishBenchmarkRun = spacetimedb.reducer(
  { runId: t.u32(), state: t.string(), message: t.string() },
  (ctx, { runId, state, message }) => {
    const run = requireRunOwner(ctx, runId);
    if (!["COMPLETED", "FAILED", "STOPPED"].includes(state)) throw new SenderError("Finish state must be COMPLETED, FAILED or STOPPED");
    if (run.state === state) return; // idempotent retry
    setRunState(ctx, run, state as BenchState, message);
  },
);
