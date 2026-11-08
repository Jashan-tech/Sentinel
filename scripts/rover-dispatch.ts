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
const SENSOR_SAMPLES = 3;
const STALE_AFTER_SECONDS = Number(env("STALE_AFTER_MINUTES", "15")) * 60;
const COOLDOWN_MS = 60_000;
const APPROACH_CM = Number(env("ROVER_APPROACH_CM", "30")); // stop this far from the box (front tip)
const APPROACH_SPEED = Number(env("ROVER_APPROACH_SPEED", "30"));
const APPROACH_MAX_MS = Number(env("ROVER_APPROACH_MAX_MS", "4000")); // never drive blind longer than this
const BACKUP_MS = Number(env("ROVER_BACKUP_MS", "700"));
const TURN_SPEED = Number(env("ROVER_TURN_SPEED", "35"));
const TURN_MS = Number(env("ROVER_TURN_MS", "700")); // roughly 90 degrees; calibrate on the floor
const CONTROL_PORT = Number(env("ROVER_CONTROL_PORT", "3002"));
const NVIDIA_API_KEY = env("NVIDIA_API_KEY");
const NVIDIA_BASE_URL = env("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
const NVIDIA_MODEL = env("NVIDIA_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b");
const INSPECT_RACK = env("ROVER_RACK", "rack-1");
// Automatic check triggers (live rover readings and simulated dashboard values).
const TRIGGERS = {
  temp_c: Number(env("TRIGGER_TEMP_C", "30")),
  humidity_pct: Number(env("TRIGGER_HUMIDITY_PCT", "60")),
  sound_min: Number(env("TRIGGER_SOUND_MIN", "250")), // sudden sound must exceed this...
  sound_factor: Number(env("TRIGGER_SOUND_FACTOR", "3")), // ...and this many times the 30 s background median
};
// Box sweep geometry (calibrate on the floor): speed APPROACH_SPEED moves CM_PER_SEC; a 90° turn takes TURN90_MS.
const CM_PER_SEC = Number(env("ROVER_CM_PER_SEC", "20"));
const TURN90_MS = Number(env("ROVER_TURN90_MS", "700"));
const BOX_CM = Number(env("ROVER_BOX_CM", "30")); // box width/depth
const SIDE_GAP_CM = Number(env("ROVER_SIDE_GAP_CM", "25")); // how far from a side face the rover stops to look
const SWEEP_SIDES: ("left" | "right")[] = JSON.parse(env("ROVER_SWEEP_SIDES", '["right"]')); // left side has cables on the floor at the venue
// Search turns (turn in place). SCAN_TURN_MS is roughly one box over; calibrate on the floor.
const SCAN_TURN_MS = Number(env("ROVER_SCAN_TURN_MS", "400"));
const SCAN_SCALES: number[] = JSON.parse(env("ROVER_SCAN_SCALES", "[1, 1.8]"));
type PatrolStep = { rack: string } | { turn: "left" | "right"; ms?: number } | { forward: number } | { back: number };
// Hard-coded "move left for a better angle" maneuver (the rover cannot strafe). Calibrate on the floor.
const LEFT_MOVE: PatrolStep[] = JSON.parse(
  env("ROVER_LEFT_MOVE", JSON.stringify([{ back: 500 }, { turn: "left", ms: 450 }, { forward: 900 }, { turn: "right", ms: 700 }])),
);
const PATROL: PatrolStep[] = JSON.parse(
  env("ROVER_PATROL", JSON.stringify([{ rack: "rack-1" }, { turn: "right" }, { rack: "rack-2" }])),
);
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

// Live status for the dashboard (GET /status on the control port).
const status = {
  armed: env("ROVER_AUTO_CHECKS", "off") === "on", // off at start so the rover never moves unexpectedly
  last_trigger: null as string | null,
  /** The last frame the rover's AI looked at, with its verdict (shown on the dashboard). */
  last_look: null as null | { t: string; where: string; view: string; rack: boolean; full: boolean; wires: boolean; reason: string; img: string },
  running: false,
  phase: "idle",
  rack: null as string | null,
  log: [] as { t: string; m: string }[],
};
/** quiet=true: console only (technical startup lines stay off the dashboard). */
const log = (m: string, quiet = false) => {
  const t = new Date().toLocaleTimeString();
  console.log(`[rover ${t}] ${m}`);
  if (quiet) return;
  status.log.push({ t, m });
  if (status.log.length > 40) status.log.shift();
};
const phase = (p: string, rack: string | null = status.rack) => {
  status.phase = p;
  status.rack = rack;
};
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

/** Smaller copy of the photo just taken (Jetson /thumb), as a data URL the dashboard can store and show. */
async function roverThumb(): Promise<string> {
  try {
    const res = await fetch(`${ROVER_URL}/thumb`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return "";
    const url = `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
    return url.length <= 58_000 ? url : "";
  } catch {
    return "";
  }
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
    thumbnailDataUrl: await roverThumb(), // dashboard preview of this exact photo (<60 KB)
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
  phase("AI investigating", rackId);
  try {
    const res = await fetch(`${AGENT_URL}/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ investigation_id: investigationId, images: "images" in request ? request.images : [] }),
      signal: AbortSignal.timeout(300_000),
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

// ---------------- missions ----------------
let busy = false;
let abort = false;
/** Every move made during the current mission, so the rover can retrace them back to its start. */
let trail: PatrolStep[] = [];
async function fwd(ms: number) { trail.push({ forward: ms }); await drive(APPROACH_SPEED, ms); }
async function back(ms: number) { trail.push({ back: ms }); await drive(-APPROACH_SPEED, ms); }
async function turn(dir: "left" | "right", ms: number) {
  trail.push({ turn: dir, ms });
  const sp = dir === "right" ? TURN_SPEED : -TURN_SPEED;
  await driveLR(sp, -sp, ms);
}
/** Undo the trail in reverse order (forward <-> back, left <-> right). */
async function returnHome() {
  if (!trail.length) return;
  phase("returning to start");
  log(`Returning to start (${trail.length} move${trail.length > 1 ? "s" : ""} to retrace).`);
  const steps = trail.reverse();
  trail = [];
  for (const st of steps) {
    if ("forward" in st) await drive(-APPROACH_SPEED, st.forward);
    else if ("back" in st) await drive(APPROACH_SPEED, st.back);
    else if ("turn" in st) {
      const sp = st.turn === "right" ? -TURN_SPEED : TURN_SPEED;
      await driveLR(sp, -sp, st.ms ?? TURN_MS);
    }
    await sleep(250);
  }
  log("Back at the starting spot.");
}
const checkAbort = () => {
  if (abort) throw new Error("stopped by operator");
};

async function approach() {
  const r = await roverText(`/approach?target=${APPROACH_CM}&speed=${APPROACH_SPEED}&max_ms=${APPROACH_MAX_MS}`, APPROACH_MAX_MS + 10_000);
  log(`approach: ${r}`);
  const ms = Number(r.match(/ms=(\d+)/)?.[1] ?? 0);
  if (ms > 0) trail.push({ forward: ms });
  if (!r.includes("stop=OK")) throw new Error(`approach did not stop cleanly: ${r}`);
  if (r.includes("reason=no-distance")) throw new Error("distance sensor went quiet; stopped for safety");
  if (r.includes("reason=timeout")) log("Nothing close ahead within the drive limit; stopping here.");
}

/** Drive up to the rack, photograph it, record real readings, run the AI, back away. */
async function inspect(db: DbConnection, rackId: string, why: string) {
  log(`INSPECT ${rackId}: ${why}`);
  if (DRIVE) {
    phase("driving to rack", rackId);
    await approach();
    checkAbort();
    await sleep(700); // let the chassis settle before the photo
  }
  phase("taking photo", rackId);
  const image = await photo();
  log(`photo ${image.width}x${image.height}, ${(image.byteSize / 1024).toFixed(0)} KB${image.thumbnailDataUrl ? "" : " (no preview)"}`);
  phase("reading sensors", rackId);
  for (let i = 0; i < SENSOR_SAMPLES; i++) {
    const s = await sensors();
    if (s.age_s === null || s.age_s > 5) throw new Error("rover sensors are offline");
    const n = await recordReadings(db, rackId, s);
    log(`reading ${i + 1}/${SENSOR_SAMPLES}: ${s.temp_c} °C, ${s.hum} %RH, sound ${s.sound}, distance ${s.dist_cm} cm (${n} recorded)`);
    if (i < SENSOR_SAMPLES - 1) await sleep(1500);
  }
  checkAbort();
  await investigate(db, rackId, image);
  checkAbort();
  if (DRIVE) {
    phase("backing away", rackId);
    await drive(-APPROACH_SPEED, BACKUP_MS);
  }
}

async function run(name: string, body: () => Promise<void>) {
  if (busy) {
    log(`busy; ignoring ${name}`);
    return false;
  }
  busy = true;
  abort = false;
  trail = [];
  status.running = true;
  try {
    await body();
    log(`${name} complete`);
  } catch (e) {
    log(`${name} aborted: ${(e as Error).message}`);
    await roverText("/cmd?c=S").catch(() => {});
  } finally {
    if (!abort) await returnHome().catch((e) => log(`could not return: ${(e as Error).message}`));
    else if (trail.length) log("Stopped by operator; not driving back.");
    busy = false;
    status.running = false;
    phase("idle", null);
  }
  return true;
}

async function patrol(db: DbConnection) {
  log(`PATROL: ${PATROL.map((s) => ("rack" in s ? s.rack : "turn" in s ? `turn ${s.turn}` : "forward" in s ? `forward ${s.forward}ms` : `back ${s.back}ms`)).join(" -> ")}`);
  for (const step of PATROL) {
    checkAbort();
    if ("rack" in step) await inspect(db, step.rack, "patrol");
    else if (!DRIVE) continue;
    else if ("turn" in step) {
      phase(`turning ${step.turn}`);
      const sp = step.turn === "right" ? TURN_SPEED : -TURN_SPEED;
      log(`turn ${step.turn}: ${await driveLR(sp, -sp, step.ms ?? TURN_MS)}`);
    } else if ("forward" in step) {
      phase("driving");
      await drive(APPROACH_SPEED, step.forward);
    } else if ("back" in step) {
      phase("backing up");
      await drive(-APPROACH_SPEED, step.back);
    }
    await sleep(400);
  }
}

// ---------------- quick look (Nemotron VL, thinking off, ~2 s) ----------------
type View = "OPEN_RACK_CABLES" | "CLOSED_DOOR_RACK" | "BLANK_PANEL" | "NO_RACK";
interface Look { view: View; rack_visible: boolean; full_rack_visible: boolean; wires_visible: boolean; reason: string }
const VIEW_LABEL: Record<View, string> = {
  OPEN_RACK_CABLES: "open rack with exposed cabling (TARGET)",
  CLOSED_DOOR_RACK: "rack behind a closed mesh door",
  BLANK_PANEL: "blank rack panel",
  NO_RACK: "no rack",
};
const LOOK_PROMPT =
  "You are the eyes of a data-center inspection rover. Classify this camera frame and answer ONLY with JSON: " +
  '{"view": "OPEN_RACK_CABLES" | "CLOSED_DOOR_RACK" | "BLANK_PANEL" | "NO_RACK", "full_rack_visible": bool, "reason": string}. ' +
  "OPEN_RACK_CABLES: the open rear of a server rack with rack-mounted equipment and network/power cables directly visible (no door). " +
  "CLOSED_DOOR_RACK: a server rack whose equipment is seen through a closed perforated/mesh front door. " +
  "BLANK_PANEL: a plain solid rack side panel or solid door with no equipment or cables visible. " +
  "NO_RACK: no server rack in view. A printed photo of a rack counts as that rack. " +
  "full_rack_visible: the rack fills most of the frame and is not badly cut off. " +
  "reason: one short plain-English sentence explaining what you see.";
async function look(): Promise<Look> {
  if (!NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY missing in agent/.env");
  const res = await fetch(`${ROVER_URL}/snap`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`rover /snap -> HTTP ${res.status}`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  const r = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${NVIDIA_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      temperature: 0,
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "user", content: [{ type: "text", text: LOOK_PROMPT }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }] }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await r.json()) as { choices?: { message?: { content?: string } }[]; error?: unknown };
  const text = body.choices?.[0]?.message?.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!r.ok || !m) throw new Error(`vision check failed (HTTP ${r.status})`);
  const j = JSON.parse(m[0]) as { view?: string; full_rack_visible?: boolean; reason?: string };
  const view: View = (["OPEN_RACK_CABLES", "CLOSED_DOOR_RACK", "BLANK_PANEL", "NO_RACK"] as const).find((v) => v === j.view) ?? "NO_RACK";
  return {
    view,
    rack_visible: view !== "NO_RACK",
    full_rack_visible: view !== "NO_RACK" && j.full_rack_visible === true,
    wires_visible: view === "OPEN_RACK_CABLES",
    reason: String(j.reason ?? "").slice(0, 300),
  };
}
async function lookAndLog(where: string) {
  phase(`looking (${where})`);
  const l = await look();
  status.last_look = {
    t: new Date().toLocaleTimeString(),
    where,
    view: VIEW_LABEL[l.view],
    rack: l.rack_visible,
    full: l.full_rack_visible,
    wires: l.wires_visible,
    reason: l.reason,
    img: await roverThumb(), // small copy of the exact frame the AI judged
  };
  log(`AI sees [${where}]: ${VIEW_LABEL[l.view]}${l.rack_visible ? (l.full_rack_visible ? ", full rack in frame" : ", rack cut off") : ""}. ${l.reason}`);
  return l;
}

async function runMoves(steps: PatrolStep[]) {
  for (const step of steps) {
    checkAbort();
    if ("turn" in step) await turn(step.turn, step.ms ?? TURN_MS);
    else if ("forward" in step) await fwd(step.forward);
    else if ("back" in step) await back(step.back);
    await sleep(300);
  }
}

/** Undo the most recent move (used to come back to center during the search). */
async function undoLast() {
  const st = trail.pop();
  if (!st) return;
  if ("forward" in st) await drive(-APPROACH_SPEED, st.forward);
  else if ("back" in st) await drive(APPROACH_SPEED, st.back);
  else if ("turn" in st) {
    const sp = st.turn === "right" ? -TURN_SPEED : TURN_SPEED;
    await driveLR(sp, -sp, st.ms ?? TURN_MS);
  }
}

/** Search pattern: look ahead; then left, back to center, right, back to center; then the same wider. */
async function findTarget(rackId: string): Promise<Look | null> {
  let l = await lookAndLog("ahead");
  if (l.view === "OPEN_RACK_CABLES") return l;
  if (!DRIVE) return null;
  for (const scale of SCAN_SCALES) {
    for (const side of ["left", "right"] as const) {
      checkAbort();
      const ms = Math.round(SCAN_TURN_MS * scale);
      log(`Not the target here (${VIEW_LABEL[l.view]}). Turning ${side} to search.`);
      phase(`searching ${side}`, rackId);
      await turn(side, ms);
      await sleep(500);
      l = await lookAndLog(`${side}${scale > 1 ? " (wider)" : ""}`);
      if (l.view === "OPEN_RACK_CABLES") return l;
      log(`Coming back to center.`);
      phase("back to center", rackId);
      await undoLast();
      await sleep(400);
    }
  }
  return null;
}

const cmToMs = (cm: number) => Math.round((cm / CM_PER_SEC) * 1000);
const other = (side: "left" | "right") => (side === "left" ? "right" : "left");

/** From the front of the box, drive around to face its `side` face. Returns how many moves were made. */
async function goToSide(side: "left" | "right") {
  const before = trail.length;
  const lateral = BOX_CM / 2 + SIDE_GAP_CM + 10; // box half + gap + rover half
  await back(cmToMs(15)); await sleep(250);
  await turn(side, TURN90_MS); await sleep(250);
  await fwd(cmToMs(lateral)); await sleep(250);
  await turn(other(side), TURN90_MS); await sleep(250);
  await fwd(cmToMs(APPROACH_CM + 15 + BOX_CM / 2)); await sleep(250);
  await turn(other(side), TURN90_MS); await sleep(400);
  return trail.length - before;
}
async function undoMoves(n: number) {
  for (let i = 0; i < n; i++) { await undoLast(); await sleep(250); }
}

/** Sweep the box: front, then each side (back to the front in between). Photograph the open cabled rack when seen. */
async function sweepInspect(db: DbConnection, rackId: string, why: string) {
  log(`SWEEP ${rackId}: ${why}`);
  phase("driving to rack", rackId);
  log("Driving up to the rack (distance sensor)...");
  await approach();
  await sleep(600);
  let image: ImageAttachment | null = null;
  const take = async (where: string) => {
    log(`Target found on the ${where}: open rack with exposed cabling. Taking the inspection photo.`);
    phase("taking photo", rackId);
    image = await photo();
    log(`photo ${image.width}x${image.height}, ${(image.byteSize / 1024).toFixed(0)} KB`);
    phase("reading sensors", rackId);
    for (let i = 0; i < SENSOR_SAMPLES; i++) {
      const s = await sensors();
      if (s.age_s === null || s.age_s > 5) throw new Error("rover sensors are offline");
      const n = await recordReadings(db, rackId, s);
      log(`reading ${i + 1}/${SENSOR_SAMPLES}: ${s.temp_c} °C, ${s.hum} %RH, sound ${s.sound} (${n} recorded)`);
      if (i < SENSOR_SAMPLES - 1) await sleep(1200);
    }
  };
  let l = await lookAndLog("front");
  if (!l.rack_visible) {
    log("AI decision: no server rack ahead, so nothing to inspect.");
    return;
  }
  if (l.view === "OPEN_RACK_CABLES") await take("front");
  else log(`Front is ${VIEW_LABEL[l.view]}: not the target. Checking the other sides.`);
  for (const side of SWEEP_SIDES) {
    checkAbort();
    phase(`driving around to the ${side} side`, rackId);
    log(`Driving around to the ${side} side of the rack...`);
    const n = await goToSide(side);
    l = await lookAndLog(`${side} side`);
    if (l.view === "OPEN_RACK_CABLES" && !image) await take(`${side} side`);
    else if (l.view !== "OPEN_RACK_CABLES") log(`${side} side is ${VIEW_LABEL[l.view]}: no photo.`);
    phase("back to the front", rackId);
    log("Going back to the front.");
    await undoMoves(n);
    await sleep(400);
  }
  await returnHome();
  if (image) await investigate(db, rackId, image);
  else log("AI decision: no open rack with exposed cabling on any side, so no photo was taken.");
}

/** Find the open rack with exposed cabling, drive up to it, photograph it, record readings, return, run the AI.
 *  Closed-door racks, blank panels and empty views are never photographed. */
async function smartInspect(db: DbConnection, rackId: string, why: string) {
  log(`SMART INSPECT ${rackId}: ${why}`);
  const found = await findTarget(rackId);
  if (!found) {
    log("AI decision: the open rack with exposed cabling was not found in the search, so no photo was taken.");
    return;
  }
  log("Target found: open rack with exposed cabling. Driving up to it.");
  let l = found;
  if (DRIVE) {
    phase("driving to rack", rackId);
    await approach();
    checkAbort();
    await sleep(600);
    l = await lookAndLog("at rack");
    if (l.rack_visible && !l.full_rack_visible) {
      log("Rack is cut off in the frame; backing up for the full view.");
      phase("backing up for full view", rackId);
      await back(500);
      await sleep(500);
      l = await lookAndLog("backed up");
    }
  }
  if (l.view !== "OPEN_RACK_CABLES") {
    log(`Up close this is ${VIEW_LABEL[l.view]}, not the target, so no photo was taken.`);
    return;
  }
  log("Full open rack with cabling in view: taking the inspection photo.");
  phase("taking photo", rackId);
  const image = await photo();
  log(`photo ${image.width}x${image.height}, ${(image.byteSize / 1024).toFixed(0)} KB${image.thumbnailDataUrl ? "" : " (no preview)"}`);
  phase("reading sensors", rackId);
  for (let i = 0; i < SENSOR_SAMPLES; i++) {
    const s = await sensors();
    if (s.age_s === null || s.age_s > 5) throw new Error("rover sensors are offline");
    const n = await recordReadings(db, rackId, s);
    log(`reading ${i + 1}/${SENSOR_SAMPLES}: ${s.temp_c} °C, ${s.hum} %RH, sound ${s.sound}, distance ${s.dist_cm} cm (${n} recorded)`);
    if (i < SENSOR_SAMPLES - 1) await sleep(1500);
  }
  checkAbort();
  await returnHome(); // drive back while the AI works
  await investigate(db, rackId, image);
}

/** ROVER_MODE=sweep (default): drive around one box. ROVER_MODE=search: turn left/right to find among several boxes. */
const inspectRack = (db: DbConnection, rackId: string, why: string) =>
  env("ROVER_MODE", "sweep") === "search" ? smartInspect(db, rackId, why) : sweepInspect(db, rackId, why);

// drive() with opposite wheel speeds turns in place
async function driveLR(l: number, r: number, ms: number) {
  return roverText(`/drive?l=${l}&r=${r}&ms=${ms}`, ms + 10_000);
}

// ---------------- main ----------------
log(`rover ${ROVER_URL}`, true);
const ping = await roverText("/cmd?c=P").catch(() => roverText("/cmd?c=P"));
if (!ping.includes("PONG")) log(`warning: motor board answered "${ping}"`);
const db = await connect();
log(`connected to SpacetimeDB ${DATABASE} as authorized agent`, true);

if (MANUAL_RACK) {
  await run(`inspection of ${MANUAL_RACK}`, () => inspectRack(db, MANUAL_RACK, "manual dispatch"));
  db.disconnect();
  setTimeout(() => process.exit(0), 200).unref();
} else if (flag("--patrol")) {
  await run("patrol", () => patrol(db));
  db.disconnect();
  setTimeout(() => process.exit(0), 200).unref();
} else {
  // Control API for the dashboard (proxied by Vite at /api/dispatch). Localhost only.
  const { createServer } = await import("node:http");
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/status") return json(200, { ...status, rack_target: INSPECT_RACK, triggers: TRIGGERS });
    if (req.method === "POST" && url.pathname === "/arm") {
      status.armed = url.searchParams.get("on") !== "0";
      log(`Auto-checks ${status.armed ? "ON" : "OFF"}`);
      return json(200, { armed: status.armed });
    }
    if (req.method === "POST" && url.pathname === "/patrol") {
      if (busy) return json(409, { error: "rover is busy" });
      void run("inspection", () => inspectRack(db, INSPECT_RACK, "dashboard Start"));
      return json(202, { started: true });
    }
    if (req.method === "POST" && url.pathname === "/inspect") {
      const rack = url.searchParams.get("rack") ?? "";
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(rack)) return json(400, { error: "bad rack" });
      if (busy) return json(409, { error: "rover is busy" });
      void run(`inspection of ${rack}`, () => inspectRack(db, rack, "dashboard request"));
      return json(202, { started: true });
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      abort = true;
      void roverText("/cmd?c=S").catch(() => {});
      log("STOP requested");
      return json(200, { stopping: true });
    }
    json(404, { error: "not found" });
  }).listen(CONTROL_PORT, "127.0.0.1", () => log(`control API on http://127.0.0.1:${CONTROL_PORT}`, true));

  const lastMission = new Map<string, number>();
  const seen = new Set([...db.db.rackAlert.iter()].filter((a) => a.active).map((a) => `${a.alertId}:${a.severity}`));
  const consider = (a: { alertId: string; rackId: string; metricType: string; severity: string; active: boolean }) => {
    if (!a.active) {
      for (const k of [...seen]) if (k.startsWith(`${a.alertId}:`)) seen.delete(k); // resolved: may fire again later
      return;
    }
    // Dashboard alarms always dispatch the rover; the Auto-checks switch only gates live-sensor triggers.
    const isTemp = a.metricType === "AMBIENT_TEMPERATURE_C";
    const isHum = a.metricType === "RELATIVE_HUMIDITY_PERCENT";
    if (!(isTemp && a.severity === "CRITICAL") && !(isHum && (a.severity === "WARNING" || a.severity === "CRITICAL"))) return;
    const key = `${a.alertId}:${a.severity}`;
    if (seen.has(key)) return;
    seen.add(key);
    const reading = [...db.db.currentTelemetry.iter()].find((c) => c.currentKey === `${a.rackId}:${a.metricType}`);
    if (reading?.sourceType !== "SIMULATOR") return; // only simulated alarms dispatch the rover
    if (Date.now() - (lastMission.get(a.rackId) ?? 0) < COOLDOWN_MS) return;
    lastMission.set(a.rackId, Date.now());
    void run(`inspection of ${a.rackId}`, () =>
      inspectRack(db, a.rackId, `${a.severity} ${a.metricType} alert (simulated ${reading.numericValue} ${reading.unit})`),
    );
  };
  db.db.rackAlert.onInsert((_ctx, a) => consider(a));
  db.db.rackAlert.onUpdate((_ctx, _old, a) => consider(a));

  // ---- automatic checks ----
  let lastAuto = 0;
  /** live=true: from the rover's own sensors (needs Auto-checks ON). Simulated dashboard values always dispatch. */
  const trigger = (reason: string, live = false) => {
    if ((live && !status.armed) || busy || Date.now() - lastAuto < COOLDOWN_MS) return;
    lastAuto = Date.now();
    status.last_trigger = `${new Date().toLocaleTimeString()} ${reason}`;
    log(`TRIGGER: ${reason}`);
    void run(`inspection of ${INSPECT_RACK}`, async () => {
      try {
        await inspectRack(db, INSPECT_RACK, reason);
      } finally {
        lastAuto = Date.now(); // cooldown counts from the end of the check
      }
    });
  };

  // Simulated values typed on the dashboard (rules only alert on temp/humidity profiles; sound has none).
  const onCurrent = (c: { rackId: string; metricType: string; numericValue: number; sourceType: string }) => {
    if (c.sourceType !== "SIMULATOR") return;
    if (c.metricType === "RELATIVE_HUMIDITY_PERCENT" && c.numericValue > TRIGGERS.humidity_pct)
      trigger(`simulated humidity ${c.numericValue}% on ${c.rackId} is above ${TRIGGERS.humidity_pct}%`);
    if (c.metricType === "SOUND_RAW" && c.numericValue > TRIGGERS.sound_min)
      trigger(`simulated sound ${c.numericValue} on ${c.rackId} is above ${TRIGGERS.sound_min}`);
    if (c.metricType === "AMBIENT_TEMPERATURE_C" && c.numericValue > TRIGGERS.temp_c)
      trigger(`simulated temperature ${c.numericValue} °C on ${c.rackId} is above ${TRIGGERS.temp_c} °C`);
  };
  db.db.currentTelemetry.onInsert((_ctx, c) => onCurrent(c));
  db.db.currentTelemetry.onUpdate((_ctx, _old, c) => onCurrent(c));

  // Live rover sensors, polled while idle.
  const soundHist: { t: number; v: number }[] = [];
  setInterval(async () => {
    if (busy) return;
    let s: RoverSensors;
    try {
      s = await sensors();
    } catch {
      return;
    }
    const now = Date.now();
    if (s.sound !== null) {
      const bg = soundHist.length >= 10 ? [...soundHist].map((x) => x.v).sort((a, b) => a - b)[Math.floor(soundHist.length / 2)] : null;
      if (bg !== null && s.sound > TRIGGERS.sound_min && s.sound > TRIGGERS.sound_factor * Math.max(bg, 1))
        trigger(`sudden loud sound: ${s.sound} vs background ${bg}`, true);
      soundHist.push({ t: now, v: s.sound });
      while (soundHist.length && now - soundHist[0].t > 30_000) soundHist.shift();
    }
    if (s.age_s !== null && s.age_s <= 5) {
      if (s.hum !== null && s.hum > TRIGGERS.humidity_pct) trigger(`humidity ${s.hum}% is above ${TRIGGERS.humidity_pct}%`, true);
      if (s.temp_c !== null && s.temp_c > TRIGGERS.temp_c) trigger(`temperature ${s.temp_c} °C is above ${TRIGGERS.temp_c} °C`, true);
    }
  }, 500);
  log("dashboard alarms and simulated values always dispatch the rover", true);
  log("Rover ready.");
  log(`live-sensor auto-checks ${status.armed ? "ON" : "OFF"}: temp > ${TRIGGERS.temp_c} °C, humidity > ${TRIGGERS.humidity_pct}%, sudden sound > ${TRIGGERS.sound_factor}x background (min ${TRIGGERS.sound_min})`, true);
  log("watching for alerts (Ctrl+C to stop)", true);
}
