import {
  schema,
  table,
  t,
  SenderError,
  type ReducerCtx,
  type InferSchema,
} from "spacetimedb/server";
import { validateObservation, evaluate, RECENT_LIMIT } from "./rules";
import {
  validateInvestigationStart,
  validateInvestigationCompletion,
} from "./investigation";

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
export const init = spacetimedb.init(seed);
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
    // This indexed scan is bounded to 51 rows; archive size never affects ingestion.
    const recent = [
      ...ctx.db.recentObservation.rackId.filter(args.rackId),
    ].sort((a, b) => {
      const d =
        a.ingestedAt.microsSinceUnixEpoch - b.ingestedAt.microsSinceUnixEpoch;
      return d < 0n
        ? -1
        : d > 0n
          ? 1
          : a.observationId < b.observationId
            ? -1
            : 1;
    });
    for (const old of recent.slice(
      0,
      Math.max(0, recent.length - RECENT_LIMIT),
    ))
      ctx.db.recentObservation.observationId.delete(old.observationId);
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

// ---- AI investigation records (Feature 2 integration) ----
// Records are append-only history: one row per investigation, never overwritten after completion.
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
  },
);
export const completeInvestigation = spacetimedb.reducer(
  {
    investigationId: t.string(),
    status: t.string(),
    severity: t.string(),
    reportJson: t.string(),
    eventsJson: t.string(),
  },
  (ctx, args) => {
    const row = ctx.db.investigation.investigationId.find(args.investigationId);
    if (!row) throw new SenderError("Unknown investigation");
    if (!row.submittedBy.isEqual(ctx.sender))
      throw new SenderError("Only the identity that started an investigation can complete it");
    if (row.status !== "RUNNING") throw new SenderError("Investigation is already complete");
    try {
      validateInvestigationCompletion(args);
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
  },
);
