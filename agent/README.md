# SENTINEL Agent: Multi-Agent Nemotron Investigation (Feature 2)

A standalone HTTP service. POST it a rack snapshot, optionally with a photo, and a team of NVIDIA Nemotron agents investigates the rack. A **Supervisor** plans the investigation and hands tasks to **Telemetry**, **Environment**, **Documentation**, **Vision** and **Verification** agents. Each of those agents runs its own Nemotron calls with its own read-only tools. LangGraph routes between them using shared state. The response is a Zod-validated diagnostic report plus a timeline of what actually ran.

The service does not depend on SpacetimeDB or the dashboard.

## Equipment intelligence (Feature 5)

[Equipment intelligence contract, source registry, rules and tests](EQUIPMENT_INTELLIGENCE.md) documents the deterministic trend/indicator tools, exact operator-identity matching, source-grounded manufacturer facts, and persisted report evidence. This extends the existing agents and real-photo workflow without adding an agent or changing the live NVIDIA model configuration. Model-specific guidance is unavailable for unidentified racks. Feature 5 end-to-end tests use the actual backend and scripted model responses; live NVIDIA inference requires the existing API key configuration.

## Quick start

```bash
cd agent
npm install
cp .env.example .env              # then set NVIDIA_API_KEY (https://build.nvidia.com)
npm run dev                       # http://localhost:3001  POST /investigate
npm run demo                      # live multi-agent run: normal, critical, stale, contradictory
npm run demo -- c-critical        # one scenario (fixture-name prefix; b2-profile = profile demo)
npm run demo -- --single          # original single-agent engine
npm run demo -- c-critical --image rack-switches-patch-panels.jpg               # telemetry + real photo
npm run demo -- a-normal --image switch-5port-led-closeup.jpg --visual-only     # photo only
npx tsx scripts/probe-vision.ts test-assets/vision/<file>                       # raw multimodal probe
npm test && npm run typecheck
npm run probe -- nvidia/<model-id>   # check a model's tool calling on your key
```

`npm run demo` starts the server in-process on a random port and calls the real `/investigate` endpoint over HTTP. It uses live Nemotron calls, with no mocks. To call a server that is already running instead, set `AGENT_URL=http://localhost:3001`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `NVIDIA_API_KEY` | required | Without it, `/investigate` returns a 500 with a clear message |
| `NVIDIA_MODEL` | `nvidia/nemotron-3.5-super-vl-120b-a12b` | Supervisor model (Nemotron Super) |
| `NVIDIA_SPECIALIST_MODEL` | same as `NVIDIA_MODEL` | Model for the specialist and verification agents. `nvidia/nemotron-3.5-lightning-30b-a3b` also supports tool calling on our key |
| `NVIDIA_VISION_MODEL` | `nvidia/nemotron-3.5-super-vl-120b-a12b` | Multimodal model for the Vision Agent, and for Verification when a photo is attached. It must accept `image_url` input |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NVIDIA's OpenAI-compatible endpoint |
| `MAX_DELEGATIONS` | `5` (hard cap 5) | Number of specialist and verification runs per investigation |
| `MAX_SPECIALIST_TOOL_ROUNDS` | `3` (hard cap 3) | Tool rounds per agent run |
| `MAX_VERIFICATION_RETRIES` | `1` | Verification can run at most 1 + this many times |
| `MAX_INVESTIGATION_SECONDS` | `90` | Wall-clock budget. 15 s of it is kept back for the final synthesis |
| `MAX_VISUAL_INVESTIGATION_SECONDS` | `130` | Budget when a photo is attached. A further 20 s is reserved so the mandatory verification can run after Vision |
| `MAX_INVESTIGATION_ROUNDS` | `5` | Tool rounds for the single-agent engine only (`?mode=single`) |
| `MAX_OUTPUT_TOKENS` | `2048` | Output cap for each model call |
| `NVIDIA_ENABLE_THINKING` | `false` | Sets `chat_template_kwargs.enable_thinking`. Reasoning text is never returned |
| `STALE_AFTER_MINUTES` | `15` | A current reading older than this, relative to `as_of`, is marked stale |
| `PORT` | `3001` | |
| `SPACETIME_AGENT_TOKEN` | none | The agent's own SpacetimeDB identity token, written by `npm run agent:register`. Without it, recorded (dashboard) investigations return 503 |
| `SPACETIME_DATABASE` / `SPACETIME_URL` | `sentinel` / `http://127.0.0.1:3000` | Where reports are recorded |

**Why `@langchain/openai`?** There is no JavaScript `@langchain/nvidia-ai-endpoints` package; it exists only for Python. NVIDIA's hosted API is OpenAI-compatible and supports `tools`, so we use `ChatOpenAI` with its base URL set to NVIDIA's endpoint. The models are still Nemotron.

## Architecture

```
src/
  server.ts      startup (loads .env, listens)
  app.ts         Express: POST /investigate (multi-agent; ?mode=single = original engine), GET /health
  multiagent.ts  multi-agent LangGraph: supervisor, 4 agents, guards, final synthesis
  graph.ts       original single-agent LangGraph and shared helpers
  tools.ts       RackDataSource (snapshot-backed), telemetry and doc tools, threshold severity policy
  schemas.ts     Zod: request, findings, verification, report, events
  model.ts       env config, ChatOpenAI pointed at NVIDIA
  fixtures/      5 simulated scenarios + docs/equipment-docs.json
```

### LangGraph nodes and edges

```
START -> supervisor --(next = telemetry | environment | documentation | verification)--> that agent -> supervisor
                    --(next = finish | limit reached | fatal error)--> final -> END
```

| Node | Model call | Tools | Output |
|---|---|---|---|
| `supervisor` | Nemotron Super, JSON decision | none | `{plan, next, objective, reason}` |
| `telemetry` | own Nemotron tool loop (≤3 rounds) | current telemetry, history, rack profile | `SpecialistFinding` |
| `environment` | own Nemotron tool loop | current telemetry, history | `SpecialistFinding` |
| `documentation` | own Nemotron tool loop | `lookup_equipment_documentation`, rack profile | `SpecialistFinding` |
| `vision` | one multimodal Nemotron VL call with the actual image as an `image_url` data URL, plus one repair attempt | none (works from the image) | `SpecialistFinding` + `visual_findings[]` |
| `verification` | own Nemotron tool loop; spot-checks claims against the data, and looks at the image itself when Vision ran | current telemetry, history | `VerificationResult` (may request a follow-up) |
| `final` | Nemotron Super synthesis | none | `MultiAgentReport` |

**Shared state.** The graph state holds the request, plan, current decision, assignments, specialist findings, the verification result, how many delegations and verification runs have happened, which limits were hit, and any fatal error. Each agent receives a digest of the earlier findings. The Supervisor sees all findings and the verification feedback before every decision.

**Guards.** These are code rules. Each time one fires, a `GUARD` event appears in the timeline.
- Limits on delegations, verification retries and total time stop the investigation and mark the report `INCOMPLETE`.
- The Supervisor cannot finish before any agent has looked at the data.
- A rack that is not clearly NORMAL, or any investigation with a photo, must go through verification. The last delegation is reserved for it.
- Vision is offered only when an image is attached. An attached image cannot be skipped, and Vision is never repeated.
- An identical task for the same agent is never re-run. In a live test the Supervisor reissued one documentation task three times.
- The final severity comes from the profile thresholds applied to fresh readings. The Supervisor is told this value before it writes the report.

**Output errors.** If any agent or the Supervisor returns malformed JSON, it gets one repair attempt. If the repair also fails, that result is marked `INCOMPLETE`. Nothing is fabricated in its place.

**Isolation.** Each request gets its own deep-copied data source, tools, graph and collectors.

**Swapping in SpacetimeDB.** Implement the three `RackDataSource` functions as SpacetimeDB queries.

## API

### `POST /investigate`

There are two modes.

**Recorded mode (used by the dashboard).** Request body: `{ "investigation_id": "<uuid>", "images": [ ... ] }`.
- The agent loads the **stored** snapshot for that `RUNNING` investigation from SpacetimeDB.
- It checks that each image's SHA-256 matches the provenance recorded for the investigation.
- It runs the investigation and records the report itself with `complete_investigation`, under its authorized identity.
- The response adds `persisted: true`, or `persisted: false` with `persist_error`.
- It keeps running if the browser disconnects.
- Error codes: 404 for an unknown investigation, 409 if it isn't running, 400 for an image mismatch or invalid stored snapshot, 503 if the agent isn't registered.

**Stateless mode (CLI demo and tests).** The full request below. Nothing is recorded, and the run is cancelled if the client disconnects.

Every model call has an enforced deadline: an `AbortSignal` combining the call's own budget, the investigation's hard stop (budget plus 15 s) and caller cancellation.

Stateless request (validated by `InvestigationRequest` in `src/schemas.ts`):

```jsonc
{
  "rack_id": "rack-001",                 // [A-Za-z0-9._-]{1,64}
  "rack_name": "Compute Rack A",
  "equipment_type": "Compute",           // Compute | Network | Storage have reference docs
  "profile": {                           // fictional demo thresholds, not vendor specs
    "name": "High-Density Compute Rack",
    "temperature_warning_c": 27,         // must be < temperature_critical_c
    "temperature_critical_c": 33,
    "humidity_warning_percent": 60,      // optional
    "humidity_critical_percent": 70      // optional
  },
  "current_telemetry": [ /* TelemetryReading */ ],   // may be empty
  "recent_telemetry":  [ /* TelemetryReading */ ],   // may be empty
  "active_alerts": [ { "severity": "CRITICAL", "message": "...", "metric_type": "AMBIENT_TEMPERATURE_C", "alert_id": "...", "raised_at": "ISO" } ],
  "as_of": "2026-11-07T14:00:00Z"        // optional reference time for staleness; default = now
}
```

Every `TelemetryReading` field is required:

- `metric_type`: one of `AMBIENT_TEMPERATURE_C`, `RELATIVE_HUMIDITY_PERCENT`, `SOUND_RAW`, `ULTRASONIC_DISTANCE_CM`. Any other metric is rejected.
- `numeric_value` and `unit`: the same units and ranges as the database (`°C` −50 to 100, `%RH` 0 to 100, `raw` ≥ 0, `cm` ≥ 0). Anything else is rejected, never converted.
- `source_type`: `SIMULATOR`, which is the only source the database authorizes. `source_identifier`: 1 to 100 characters, not blank.
- `observed_at`, `ingested_at`: ISO datetimes, from 2000 onward. `observed_at` may be at most 30 s after `ingested_at`, and neither may be more than 30 s after `as_of`.
- `simulated`: must be `true` exactly when `source_type` is `SIMULATOR`.
- An `observation_id` that appears twice must describe the same reading.

Response codes:

| Code | Meaning |
|---|---|
| 200 | `{ report, events }`. Status is `COMPLETED` or `INCOMPLETE` |
| 400 | The request failed validation. The body lists the validation issues |
| 500 | The service is misconfigured, for example the API key is missing |
| 502 | Status is `FAILED`: the model API failed |

Report (`MultiAgentReport`). The original single-agent fields come first and the multi-agent fields follow:

```jsonc
{
  "rack_id": "...",
  "severity": "NORMAL|WARNING|CRITICAL|UNKNOWN",
  "summary": "measured facts + configured thresholds, provenance noted",
  "hypotheses": [{ "description": "", "supporting_evidence": [], "contradicting_evidence": [], "missing_evidence": [] }],
  "recommended_next_inspection": ["..."],
  "tool_calls": [{ "agent": "telemetry", "round": 1, "tool": "get_rack_profile", "args": {}, "status": "SUCCESS|ERROR", "result_summary": "" }],
  "investigation_status": "COMPLETED|INCOMPLETE|FAILED",
  "model": "nvidia/...",
  "generated_at": "ISO",
  "supervisor_plan": "...",
  "agents_invoked": [{ "agent": "telemetry", "objective": "...", "status": "COMPLETED" }],
  "specialist_findings": [{ "agent", "objective", "observations": [], "hypotheses": [], "missing_information": [], "recommended_next_action", "tools_executed": [], "status" }],
  "verification": { "grounded", "verified_findings", "unsupported_claims", "contradictions", "missing_evidence", "request_more_investigation", "follow_up_agent", "follow_up_objective", "tools_executed", "status" } | null,
  "verified_findings": ["claims the Verification Agent confirmed"],
  "missing_information": ["unavailable / stale evidence"],
  "evidence": {                           // compiled by code from actual tool output, not written by a model
    "measurements": [ /* readings with source_identifier, observed_at, simulated, stale */ ],
    "history": [ /* per-metric stats, range, sources */ ],
    "configured_thresholds": { "...": "...", "provenance": "FICTIONAL_DEMO_CONFIGURATION" },
    "documentation": [ { "doc_id", "title", "source_type", "verified", "availability" } ]
  },
  "limits_reached": [],                   // e.g. MAX_DELEGATIONS, MAX_INVESTIGATION_SECONDS, VERIFICATION_TIMEOUT
  "verification_required": true,          // a photo was supplied, severity isn't NORMAL, or there is an early-warning trend
  "verification_outcome": "VERIFIED|NOT_GROUNDED|INCOMPLETE|FAILED|NOT_RUN|NOT_REQUIRED",
  "unsupported_claims": ["from the latest verification; never upgraded by the synthesis"],
  "incomplete_reasons": ["why the status is not COMPLETED"]
}
```

These fields are computed by code from what actually happened, never written by a model:
- **`investigation_status`** is `COMPLETED` only when every agent completed, no limit was reached, and required verification is `VERIFIED`.
- **`verification_outcome`** is `NOT_GROUNDED` when the verifier says `grounded: false` or reports any unresolved contradiction. Entries such as "No contradiction…" are ignored.
- **`verified_findings`** contains only claims that the latest *completed* verification accepted and didn't also reject. Any "verified" items the final synthesis adds are ignored, and hypotheses that restate an unsupported claim are removed. Both actions appear as `GUARD` events.
- **The verification gate.** When a photo is supplied, a fixed gate step before the final report sends any unverified findings to Verification, outside the delegation and retry caps. If time runs out, it records `VERIFICATION_TIMEOUT`.

The report keeps different kinds of information in separate fields:

| Kind of information | Field |
|---|---|
| Measured facts | `evidence.measurements` and `evidence.history` |
| Configured thresholds | `evidence.configured_thresholds` |
| Agent hypotheses | `hypotheses` and `specialist_findings[].hypotheses` |
| Verified findings | `verified_findings` |
| Unavailable evidence | `missing_information` |

Each entry in `events` has the form `{ type, timestamp, agent?, tool?, description, status }`. `type` is one of START, SUPERVISOR, AGENT, TOOL, VERIFY, GUARD, REPORT, ERROR or END, and `status` is SUCCESS, ERROR or INFO. Events are recorded while the graph runs, and they never contain model reasoning text.

### Images (Feature 4)

Optional request fields:

```jsonc
"images": [{                         // at most 1
  "image_id": "img-…",               // optional; generated if omitted
  "filename": "rack.jpg",
  "mime_type": "image/jpeg",         // or image/png; must match the actual bytes
  "data_base64": "…",                // ≤ 4 MB decoded, ≤ 4096 px per side
  "source_type": "MANUAL_UPLOAD" | "ONLINE_REFERENCE" | "ROVER_CAMERA",
  "capture_timestamp": "ISO" | null, // only when actually known; never inferred
  "source_url": "https://…" | null,  // metadata only; never fetched
  "attribution": "…" | null, "license": "…" | null
}],
"inspection_mode": "TELEMETRY" | "VISUAL" | "COMBINED"   // informs the Supervisor
```

- **Validation:** `src/images.ts` checks the real JPEG or PNG signature, reads the dimensions from the header, rejects truncated files and enforces the limits. The checks fail with `400`; a request body that is too large fails with `413`. `?mode=single` combined with images is a `400`.
- **Provenance:** the server computes the SHA-256 of the received bytes and the upload time. `report.evidence.images[]` holds the provenance, and `report.visual_findings[]` holds every visual finding with its `image_id`.
- **What each finding contains:** `observation`, `component`, `image_location`, `category` (EQUIPMENT, PORT, CABLE, LABEL, LED, PHYSICAL_IRREGULARITY, OBSTRUCTION or OTHER), `visual_evidence`, `certainty` (CERTAIN or UNCERTAIN), `potential_concern`, `limitations` and `recommended_follow_up`. There are no confidence scores.
- **What leaves the server:** image bytes are sent only to NVIDIA for inference and never appear in the report.
- **Prompt injection:** the Vision and Verification prompts state that text inside an image is data, never instructions.

The test photos are in [`test-assets/vision/`](test-assets/vision/): six Wikimedia Commons images, `manifest.json` with each one's license, creator and hash, and a human review guide.

`POST /investigate?mode=single` runs the original single-agent engine. It returns the original `DiagnosticReport` without the multi-agent fields.

## Tools (all read-only)

| Tool | Args | Returns |
|---|---|---|
| `get_current_telemetry` | `rack_id`, `metric_type?` | Readings with full provenance, `age_minutes`, `stale`, `missing_metrics` |
| `get_telemetry_history` | `rack_id`, `metric_type`, `limit?` (default 10, max 50) | Observations oldest to newest with `age_minutes`, and stats. `available:false` when there are none |
| `get_rack_profile` | `rack_id` | Equipment type and fictional thresholds |
| `analyze_telemetry_trends` | `rack_id`, `metric_type`, `source_identifier?` | Deterministic source-separated statistics, windows, breaches and data quality |
| `get_early_warning_indicators` | `rack_id`, `metric_type`, `source_identifier?` | Conditions, trends and data-quality rules; no fault forecasts |
| `lookup_equipment_documentation` | `equipment_type`, `topic?` | Local reference docs, each labelled with its provenance |

The documentation set (`src/fixtures/docs/equipment-docs.json`) holds concise sourced facts, not full manuals:
- a note that the demo profiles are fictional
- the project's notes on the rover's sensors
- an explicit **UNAVAILABLE** fallback for unidentified equipment
- four exact-model section records from three official Cisco, Dell, and HPE documents, each carrying its source, revision, applicability conditions and limitations

Tool results are capped at 8,000 characters. If a result would be longer, the oldest history entries are dropped first so the JSON stays valid.

## Scenarios (all simulated)

| Fixture | Situation | Agents chosen in a live run (2026-11-07) |
|---|---|---|
| `a-normal` | Network rack, all readings in range | telemetry → finish (12 s) |
| `b-elevated` | Compute rack at 29.6 C, above the 27 C warning, rising | (not in the default run) |
| `c-critical` | Compute rack at 35.4 C, above the 33 C critical threshold, rising, SOUND_RAW climbing | telemetry → documentation → environment → verification (42 s) |
| `d-stale` | Storage rack. The only reading is 3 hours old | telemetry → documentation → verification (22 s) |
| `e-contradictory` | Two temperature sensors on the rack read 34.8 C and 25.2 C | telemetry → environment → documentation → verification (34 s) |
| `b2-profile` (demo only) | B's readings under a Network profile with a 32 C warning threshold | Profile sensitivity: B is WARNING, B2 is NORMAL |

The Supervisor picks the sequence each time, so it can differ between runs.

## Latency and token use (measured live)

These figures come from live runs of `nvidia/nemotron-3.5-super-vl-120b-a12b` on the critical-rack scenario, using NVIDIA's own usage counts. Runs vary with how many agents the Supervisor chooses.

| Scenario | Before the efficiency changes | After |
|---|---|---|
| Telemetry only | 57.9 s, 114.7k input / 6.8k output tokens | 52.3 s, 83.7k / 6.2k |
| Telemetry + photo | 104.6 s, 187.9k / 11.1k (INCOMPLETE) | 63.0 s, 93.0k / 6.6k |

What changed:
- The Supervisor gets the full code-computed monitoring evidence only for its first decision, then a compact digest.
- Verification receives that evidence up front and calls tools only for what it doesn't cover.
- A repeated verification is skipped when nothing new has been found since the last completed one; a retry after a failed verification is still allowed.
- A verification requested before any findings exist is redirected to Vision, or to Telemetry if there's no uninspected photo.

Verification and Supervisor routing remain the largest token consumers.

## Known limitations

- Tools read from the snapshot sent with the request. They are not yet wired to SpacetimeDB.
- The final severity comes from the code policy described under Guards, not from the model. The Supervisor usually agrees with it. If it doesn't, a `GUARD` event records the change.
- In live runs the Supervisor sometimes tried to finish a CRITICAL investigation without verification. The guard then routed it to verification.
- The curated manufacturer records require an exact explicit operator identity. They are conditional references, not automatic compliance checks; other models/topics return NO_MATCH.
- A multi-agent investigation takes about 12–45 s and returns everything in one response; nothing is streamed.
- `nvidia/nemotron-3-super-120b-a12b` and `nemotron-nano-3-30b-a3b` return 404 for our key.
