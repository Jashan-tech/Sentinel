// Rover dispatcher: connects SENTINEL to the physical rover (Jetson HTTP server, see README "Rover").
//
// Watch mode (default): when a rack raises a new CRITICAL temperature/humidity alert from SIMULATED
// telemetry, the rover is sent on an inspection mission:
//   1. drive toward the rack (Jetson /drive keeps the motors fed locally, then stops)
//   2. take a clean photo (Jetson /snap, no overlay)
//   3. read its real sensors (Jetson /sensor) and record them for that rack as ROVER readings
//   4. start a COMBINED investigation with the photo (ROVER_CAMERA) and let the agent service run it
//   5. drive back
// Manual mode: --rack rack-2 runs one mission immediately and exits.
//
// It uses the agent service's SpacetimeDB identity (SPACETIME_AGENT_TOKEN in agent/.env, written by
// `npm run agent:register`); the database accepts ROVER readings only from an authorized agent identity.
//
//   ROVER_URL='http://[2607:...]:8000' npm run rover:dispatch
//   ROVER_URL=... npm run rover:dispatch -- --rack rack-2
//   ROVER_URL=... npm run rover:dispatch -- --rack rack-2 --no-drive   (photo + sensors only)
import { readFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Timestamp } from "spacetimedb";
import { DbConnection } from "../dashboard/src/module_bindings";
import {
  buildInvestigationRequest,
  snapshotForStorage,
  sniffImageType,
  type ImageAttachment,
} from "../dashboard/src/investigation";
import { assignedIdentity } from "../dashboard/src/equipmentView";
import { catalogEntry } from "../spacetimedb/src/equipmentCatalog";

// ---------------- config ----------------
function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const agentEnv = readEnv(fileURLToPath(new URL("../agent/.env", import.meta.url)));
const env = (k: string, d = "") => process.env[k] ?? agentEnv[k] ?? d;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const ROVER_URL = env("ROVER_URL").replace(/\/$/, "");
const SPACETIME_HTTP = env("SPACETIME_URL", "http://127.0.0.1:3000").replace(/\/$/, "");
const SPACETIME_WS = SPACETIME_HTTP.replace(/^http/, "ws");
const DATABASE = env("SPACETIME_DATABASE", "sentinel");
const TOKEN = env("SPACETIME_AGENT_TOKEN");
const AGENT_URL = env("AGENT_URL", `http://127.0.0.1:${env("PORT", "3001")}`).replace(/\/$/, "");
const DRIVE_SPEED = Number(env("ROVER_DRIVE_SPEED", "40")); // -100..100
const DRIVE_MS = Math.min(3000, Number(env("ROVER_DRIVE_MS", "1500"))); // hard cap 3 s per leg
const SENSOR_SAMPLES = 3;
const STALE_AFTER_SECONDS = Number(env("STALE_AFTER_MINUTES", "15")) * 60;
const COOLDOWN_MS = 60_000;
const DRIVE = !flag("--no-drive");
const MANUAL_RACK = opt("--rack");

if (!ROVER_URL) {
  console.error("Set ROVER_URL, e.g. ROVER_URL='http://[2607:...]:8000'");
  process.exit(2);
}
if (!TOKEN) {
  console.error("No SPACETIME_AGENT_TOKEN in agent/.env. Run `npm run agent:register` first.");
  process.exit(2);
}

const log = (m: string) => console.log(`[rover ${new Date().toLocaleTimeString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- rover HTTP ----------------
async function roverText(path: string, timeoutMs = 10_000) {
  const res = await fetch(`${ROVER_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  if (!res.ok) throw new Error(`rover ${path} -> HTTP ${res.status} ${body}`);
  return body;
}
async function drive(speed: number, ms: number) {
  const r = await roverText(`/drive?l=${speed}&r=${speed}&ms=${ms}`, ms + 10_000);
  if (!r.startsWith("DONE") || !r.includes("stop=OK")) throw new Error(`drive did not finish cleanly: ${r}`);
  return r;
}
interface RoverSensors { temp_c: number | null; hum: number | null; dist_cm: number | null; sound: number | null; age_s: number | null }
async function sensors(): Promise<RoverSensors> {
  return JSON.parse(await roverText("/sensor")) as RoverSensors;
}

/** Width/height from a baseline or progressive JPEG SOF marker. */
function jpegSize(b: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf))
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  throw new Error("could not read JPEG dimensions");
}

async function photo(): Promise<ImageAttachment> {
  const res = await fetch(`${ROVER_URL}/snap`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`rover /snap -> HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sniffImageType(bytes) !== "image/jpeg") throw new Error("rover photo is not a JPEG");
  const { width, height } = jpegSize(bytes);
  const now = new Date();
  return {
    imageId: `img-${randomUUID()}`,
    filename: `rover-${now.toISOString().replace(/[:.]/g, "-")}.jpg`,
    mimeType: "image/jpeg",
    base64: Buffer.from(bytes).toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    width,
    height,
    thumbnailDataUrl: "", // optional preview; provenance is still stored
    sourceType: "ROVER_CAMERA",
    captureTimestamp: now.toISOString(),
    sourceUrl: "",
    attribution: "SENTINEL rover camera (Logitech Brio 101 on Jetson Orin Nano)",
    license: "",
  };
}

// ---------------- SpacetimeDB ----------------
function connect(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SpacetimeDB connection timeout")), 10_000);
    DbConnection.builder()
      .withUri(SPACETIME_WS)
      .withDatabaseName(DATABASE)
      .withToken(TOKEN)
      .onConnect((c) => {
        c.subscriptionBuilder()
          .onApplied(() => { clearTimeout(timer); resolve(c); })
          .onError((ctx) => reject(ctx.event ?? new Error("subscription rejected")))
          .subscribe([
            "SELECT * FROM rack",
            "SELECT * FROM rack_profile",
            "SELECT * FROM rack_profile_source",
            "SELECT * FROM rack_equipment",
            "SELECT * FROM current_telemetry",
            "SELECT * FROM recent_observation",
            "SELECT * FROM rack_alert",
          ]);
      })
      .onConnectError((_c, e) => { clearTimeout(timer); reject(e); })
      .build();
  });
}

async function recordReadings(db: DbConnection, rackId: string, s: RoverSensors) {
  const rows: [string, number | null, string][] = [
    ["AMBIENT_TEMPERATURE_C", s.temp_c, "°C"],
    ["RELATIVE_HUMIDITY_PERCENT", s.hum, "%RH"],
    ["SOUND_RAW", s.sound, "raw"],
    ["ULTRASONIC_DISTANCE_CM", s.dist_cm, "cm"],
  ];
  let n = 0;
  for (const [metricType, value, unit] of rows) {
    if (value === null || !Number.isFinite(value)) continue; // missing stays missing
    await db.reducers.ingestSimulatedObservation({
      rackId,
      metricType,
      numericValue: value,
      unit,
      sourceType: "ROVER",
      sourceIdentifier: "sentinel-rover-01",
      observedAt: Timestamp.now(),
    });
    n++;
  }
  return n;
}

async function investigate(db: DbConnection, rackId: string, image: ImageAttachment) {
  const rack = [...db.db.rack.iter()].find((r) => r.rackId === rackId);
  if (!rack) throw new Error(`unknown rack ${rackId}`);
  const profile = [...db.db.rackProfile.iter()].find((p) => p.profileId === rack.profileId);
  if (!profile) throw new Error(`rack ${rackId} has no profile`);
  const assigned = catalogEntry([...db.db.rackEquipment.iter()].find((e) => e.rackId === rackId)?.modelId ?? "");
  const profileSource = [...db.db.rackProfileSource.iter()].find((p) => p.profileId === rack.profileId);
  const request = buildInvestigationRequest(
    {
      rack,
      profile,
      current: [...db.db.currentTelemetry.iter()],
      recent: [...db.db.recentObservation.iter()],
      alerts: [...db.db.rackAlert.iter()],
      asOf: new Date(),
      staleAfterSeconds: STALE_AFTER_SECONDS,
      ...(profileSource && assigned && profileSource.modelId === assigned.modelId
        ? {
            thresholdSource: {
              kind: "MANUFACTURER_DOCUMENTED_RANGE" as const,
              doc_id: profileSource.docId,
              manufacturer: assigned.manufacturer,
              model: assigned.model,
              source_url: profileSource.sourceUrl,
              mapping: profileSource.mapping,
            },
          }
        : {}),
    },
    { mode: "COMBINED", image, ...(assigned ? { equipmentIdentity: assignedIdentity(assigned) } : {}) },
  );
  const investigationId = randomUUID();
  await db.reducers.startInvestigation({
    investigationId,
    rackId,
    snapshotJson: JSON.stringify(snapshotForStorage(request, image)),
  });
  await db.reducers.attachInvestigationImage({
    investigationId,
    imageId: image.imageId,
    filename: image.filename,
    mimeType: image.mimeType,
    sourceType: image.sourceType,
    captureTimestamp: new Timestamp(BigInt(Date.parse(image.captureTimestamp!)) * 1000n),
    sourceUrl: image.sourceUrl,
    attribution: image.attribution,
    license: image.license,
    sha256: image.sha256,
    byteSize: image.byteSize,
    width: image.width,
    height: image.height,
    thumbnailDataUrl: image.thumbnailDataUrl,
  });
  log(`investigation ${investigationId} started; Nemotron agents are working (watch the dashboard)`);
  try {
    const res = await fetch(`${AGENT_URL}/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ investigation_id: investigationId, images: "images" in request ? request.images : [] }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await res.json().catch(() => null)) as { report?: { severity?: string; headline?: string; summary?: string }; persisted?: boolean; error?: string; message?: string } | null;
    if (!body?.report) throw new Error(body?.message ?? body?.error ?? `agent HTTP ${res.status}`);
    log(`report: ${body.report.severity} - ${body.report.headline ?? body.report.summary ?? ""}${body.persisted ? "" : " (NOT persisted)"}`);
  } catch (e) {
    const reason = (e as Error).message;
    log(`investigation failed: ${reason}`);
    await db.reducers.abandonInvestigation({ investigationId, reason: `Rover dispatcher: ${reason}` }).catch(() => {});
  }
}

// ---------------- mission ----------------
let busy = false;
async function mission(db: DbConnection, rackId: string, why: string) {
  if (busy) return;
  busy = true;
  let drove = false;
  try {
    log(`MISSION ${rackId}: ${why}`);
    if (DRIVE) {
      log(`driving to ${rackId} (${DRIVE_MS} ms at ${DRIVE_SPEED})`);
      await drive(DRIVE_SPEED, DRIVE_MS);
      drove = true;
      await sleep(800); // let the chassis settle before the photo
    }
    const image = await photo();
    log(`photo ${image.width}x${image.height}, ${(image.byteSize / 1024).toFixed(0)} KB`);
    for (let i = 0; i < SENSOR_SAMPLES; i++) {
      const s = await sensors();
      if (s.age_s === null || s.age_s > 5) throw new Error("rover sensors are offline");
      const n = await recordReadings(db, rackId, s);
      log(`rover reading ${i + 1}/${SENSOR_SAMPLES}: ${s.temp_c} °C, ${s.hum} %RH, sound ${s.sound}, distance ${s.dist_cm} cm (${n} recorded)`);
      if (i < SENSOR_SAMPLES - 1) await sleep(2000);
    }
    await investigate(db, rackId, image);
  } catch (e) {
    log(`mission aborted: ${(e as Error).message}`);
  } finally {
    if (drove) {
      try {
        log("driving back");
        await drive(-DRIVE_SPEED, DRIVE_MS);
      } catch (e) {
        log(`could not drive back: ${(e as Error).message}`);
      }
    }
    busy = false;
  }
}

// ---------------- main ----------------
log(`rover ${ROVER_URL}`);
const ping = await roverText("/cmd?c=P").catch(() => roverText("/cmd?c=P"));
if (!ping.includes("PONG")) log(`warning: motor board answered "${ping}"`);
const db = await connect();
log(`connected to SpacetimeDB ${DATABASE} as authorized agent`);

if (MANUAL_RACK) {
  await mission(db, MANUAL_RACK, "manual dispatch");
  db.disconnect();
  setTimeout(() => process.exit(0), 200).unref();
} else {
  const lastMission = new Map<string, number>();
  const seen = new Set([...db.db.rackAlert.iter()].filter((a) => a.active).map((a) => `${a.alertId}:${a.severity}`));
  const consider = (a: { alertId: string; rackId: string; metricType: string; severity: string; active: boolean }) => {
    if (!a.active) {
      for (const k of [...seen]) if (k.startsWith(`${a.alertId}:`)) seen.delete(k); // resolved: may fire again later
      return;
    }
    if (a.severity !== "CRITICAL") return;
    if (!["AMBIENT_TEMPERATURE_C", "RELATIVE_HUMIDITY_PERCENT"].includes(a.metricType)) return;
    const key = `${a.alertId}:${a.severity}`;
    if (seen.has(key)) return;
    seen.add(key);
    const reading = [...db.db.currentTelemetry.iter()].find((c) => c.currentKey === `${a.rackId}:${a.metricType}`);
    if (reading?.sourceType !== "SIMULATOR") return; // only simulated alarms dispatch the rover
    if (Date.now() - (lastMission.get(a.rackId) ?? 0) < COOLDOWN_MS) return;
    lastMission.set(a.rackId, Date.now());
    void mission(db, a.rackId, `${a.severity} ${a.metricType} alert (simulated ${reading.numericValue} ${reading.unit})`);
  };
  db.db.rackAlert.onInsert((_ctx, a) => consider(a));
  db.db.rackAlert.onUpdate((_ctx, _old, a) => consider(a));
  log("watching for CRITICAL simulated alerts (Ctrl+C to stop)");
}
