# SENTINEL Agent: Multi-Agent Nemotron Investigation (Feature 2)

A standalone HTTP service. POST it a rack snapshot and a team of NVIDIA Nemotron agents investigates the rack. A **Supervisor** plans the investigation and hands tasks to **Telemetry**, **Environment**, **Documentation** and **Verification** agents. Each of those agents runs its own Nemotron calls with its own read-only tools. LangGraph routes between them using shared state. The response is a Zod-validated diagnostic report plus a timeline of what actually ran.

The service does not depend on SpacetimeDB or the dashboard.

## Quick start

```bash
cd agent
npm install
cp .env.example .env              # then set NVIDIA_API_KEY (https://build.nvidia.com)
npm run dev                       # http://localhost:3001  POST /investigate
npm run demo                      # live multi-agent run: normal, critical, stale, contradictory
npm run demo -- c-critical        # one scenario (fixture-name prefix; b2-profile = profile demo)
npm run demo -- --single          # original single-agent engine
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
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NVIDIA's OpenAI-compatible endpoint |
| `MAX_DELEGATIONS` | `5` (hard cap 5) | Number of specialist and verification runs per investigation |
| `MAX_SPECIALIST_TOOL_ROUNDS` | `3` (hard cap 3) | Tool rounds per agent run |
| `MAX_VERIFICATION_RETRIES` | `1` | Verification can run at most 1 + this many times |
| `MAX_INVESTIGATION_SECONDS` | `90` | Wall-clock budget. 15 s of it is kept back for the final synthesis |
| `MAX_INVESTIGATION_ROUNDS` | `5` | Tool rounds for the single-agent engine only (`?mode=single`) |
| `MAX_OUTPUT_TOKENS` | `2048` | Output cap for each model call |
| `NVIDIA_ENABLE_THINKING` | `false` | Sets `chat_template_kwargs.enable_thinking`. Reasoning text is never returned |
| `STALE_AFTER_MINUTES` | `15` | A current reading older than this, relative to `as_of`, is marked stale |
| `PORT` | `3001` | |

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
| `verification` | own Nemotron tool loop; spot-checks claims against the data | current telemetry, history | `VerificationResult` (may request a follow-up) |
| `final` | Nemotron Super synthesis | none | `MultiAgentReport` |

**Shared state.** The graph state holds the request, plan, current decision, assignments, specialist findings, the verification result, how many delegations and verification runs have happened, which limits were hit, and any fatal error. Each agent receives a digest of the earlier findings. The Supervisor sees all findings and the verification feedback before every decision.

**Guards.** These are code rules. Each time one fires, a `GUARD` event appears in the timeline.
- Limits on delegations, verification retries and total time stop the investigation and mark the report `INCOMPLETE`.
- The Supervisor cannot finish before any agent has looked at the data.
- A rack that is not clearly NORMAL must go through verification before the investigation finishes.
- The final severity comes from the profile thresholds applied to fresh readings. The Supervisor is told this value before it writes the report.

**Output errors.** If any agent or the Supervisor returns malformed JSON, it gets one repair attempt. If the repair also fails, that result is marked `INCOMPLETE`. Nothing is fabricated in its place.

**Isolation.** Each request gets its own deep-copied data source, tools, graph and collectors.

**Swapping in SpacetimeDB.** Implement the three `RackDataSource` functions as SpacetimeDB queries.

## API

### `POST /investigate`

Request (validated by `InvestigationRequest` in `src/schemas.ts`):

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
- `numeric_value`, `unit`, `source_type`, `source_identifier`
- `observed_at`, `ingested_at`: ISO datetimes
- `simulated`

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
  "limits_reached": []                    // e.g. MAX_DELEGATIONS, MAX_INVESTIGATION_SECONDS
}
```

The report keeps different kinds of information in separate fields:

| Kind of information | Field |
|---|---|
| Measured facts | `evidence.measurements` and `evidence.history` |
| Configured thresholds | `evidence.configured_thresholds` |
| Agent hypotheses | `hypotheses` and `specialist_findings[].hypotheses` |
| Verified findings | `verified_findings` |
| Unavailable evidence | `missing_information` |

Each entry in `events` has the form `{ type, timestamp, agent?, tool?, description, status }`. `type` is one of START, SUPERVISOR, AGENT, TOOL, VERIFY, GUARD, REPORT, ERROR or END, and `status` is SUCCESS, ERROR or INFO. Events are recorded while the graph runs, and they never contain model reasoning text.

`POST /investigate?mode=single` runs the original single-agent engine. It returns the original `DiagnosticReport` without the multi-agent fields.

## Tools (all read-only)

| Tool | Args | Returns |
|---|---|---|
| `get_current_telemetry` | `rack_id`, `metric_type?` | Readings with full provenance, `age_minutes`, `stale`, `missing_metrics` |
| `get_telemetry_history` | `rack_id`, `metric_type`, `limit?` (default 10, max 50) | Observations oldest to newest with `age_minutes`, and stats. `available:false` when there are none |
| `get_rack_profile` | `rack_id` | Equipment type and fictional thresholds |
| `lookup_equipment_documentation` | `equipment_type`, `topic?` | Local reference docs, each labelled with its provenance |

The documentation set (`src/fixtures/docs/equipment-docs.json`) contains no manufacturer manuals. It holds:
- a note that the demo profiles are fictional
- the project's notes on the rover's sensors
- one explicit **UNAVAILABLE** manufacturer-spec entry per equipment type

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

## Known limitations

- Tools read from the snapshot sent with the request. They are not yet wired to SpacetimeDB.
- The final severity comes from the code policy described under Guards, not from the model. The Supervisor usually agrees with it. If it doesn't, a `GUARD` event records the change.
- In live runs the Supervisor sometimes tried to finish a CRITICAL investigation without verification. The guard then routed it to verification.
- The documentation set is intentionally minimal and includes no manufacturer specs. Agents report the specs as unavailable.
- A multi-agent investigation takes about 12–45 s and returns everything in one response; nothing is streamed.
- `nvidia/nemotron-3-super-120b-a12b` and `nemotron-nano-3-30b-a3b` return 404 for our key.
