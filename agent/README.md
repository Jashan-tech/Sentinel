# SENTINEL Agent: Nemotron Investigation Engine (Feature 2)

A standalone HTTP service. You POST a rack snapshot to it, and an NVIDIA Nemotron agent running on LangGraph investigates the rack: it picks read-only tools, reads what they return, and decides what to look at next. It finishes with a Zod-validated diagnostic report and a timeline of the real execution.

It runs without SpacetimeDB and without the dashboard.

## Quick start

```bash
cd agent
npm install
cp .env.example .env        # then set NVIDIA_API_KEY (https://build.nvidia.com)
npm run dev                 # http://localhost:3001  POST /investigate
npm run demo                # live Nemotron run over all sample scenarios
npm run demo -- c-critical  # one scenario
npm test && npm run typecheck
npm run probe -- nvidia/<model-id>   # check a model's tool calling on your key
```

`npm run demo` starts the server in-process on a random port and calls the real `/investigate` endpoint over HTTP. To target a server that is already running, set `AGENT_URL=http://localhost:3001`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `NVIDIA_API_KEY` | required | Without it, `/investigate` returns 500 with a clear message |
| `NVIDIA_MODEL` | `nvidia/nemotron-3.5-super-vl-120b-a12b` | Nemotron model hosted by NVIDIA, with tool calling |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible endpoint |
| `PORT` | `3001` | |
| `MAX_INVESTIGATION_ROUNDS` | `5` | Tool-execution rounds. Hard cap is 5 |
| `MAX_OUTPUT_TOKENS` | `2048` | Cap per model call |
| `NVIDIA_ENABLE_THINKING` | `false` | Sends `chat_template_kwargs.enable_thinking`. Reasoning text is never returned |
| `STALE_AFTER_MINUTES` | `15` | Readings older than this, relative to `as_of`, are flagged stale |

**Why `@langchain/openai`:** there is no JavaScript `@langchain/nvidia-ai-endpoints` package; it exists only for Python. NVIDIA's hosted API is OpenAI-compatible and supports `tools`, so we use `ChatOpenAI` with `baseURL` pointed at NVIDIA. The model is still Nemotron.

## Architecture

```
src/
  server.ts   startup (loads .env, listens)
  app.ts      Express app: POST /investigate, GET /health
  schemas.ts  Zod: request, report, events
  tools.ts    RackDataSource (snapshot-backed) + 3 LangChain tools
  graph.ts    LangGraph StateGraph + per-request event collector
  model.ts    env config + ChatOpenAI -> NVIDIA endpoint
  fixtures/   4 simulated scenarios
scripts/demo.ts
tests/        node:test with a scripted fake model (no API cost)
```

```
START -> investigate --(tool calls, budget left)--> tools --> investigate
              |--(no tool calls | budget exhausted | model error)--> report -> END
```

- **investigate:** Nemotron, with the tools bound, sees the rack identity, the active alerts and every earlier tool result, and decides which tool to call next or whether to stop. Telemetry and thresholds are not in the prompt. Nemotron has to fetch them with tools.
- **tools:** runs the tool calls Nemotron chose. A bad argument (caught by Zod), an unknown tool or a wrong rack comes back to the model as an `{error}` result, so it can adjust.
- **report:** one call with no tools bound asks for JSON only. The output is validated against `ModelReport`. If it fails, the model gets one repair attempt. If that also fails, the report is marked `INCOMPLETE` with severity `UNKNOWN` and no diagnosis. `tool_calls` is always filled in from the actual executions, never from what the model says it did.
- **Isolation:** each request gets its own deep-copied data source, tools, graph and event list. No global mutable state.
- **Swapping in SpacetimeDB:** implement `RackDataSource` (three functions) over SpacetimeDB queries and pass it to `createTools`.

## API

### `POST /investigate`

Request (validated by `InvestigationRequest` in `src/schemas.ts`):

```jsonc
{
  "rack_id": "rack-001",                 // [A-Za-z0-9._-]{1,64}
  "rack_name": "Compute Rack A",
  "equipment_type": "Compute",
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

`TelemetryReading` has these fields, all required: `metric_type` (one of `AMBIENT_TEMPERATURE_C`, `RELATIVE_HUMIDITY_PERCENT`, `SOUND_RAW`, `ULTRASONIC_DISTANCE_CM`), `numeric_value`, `unit`, `source_type`, `source_identifier`, `observed_at`, `ingested_at` (both ISO datetimes) and `simulated`. Any other metric is rejected.

Response codes:

- **200:** `{ report, events }`. The report status is `COMPLETED` or `INCOMPLETE`.
- **400:** the request failed validation. The response includes the validation issues.
- **500:** the agent is misconfigured, for example the API key is missing.
- **502:** `{ report, events }` with status `FAILED`, because the model API failed.

Report:

```jsonc
{
  "rack_id": "...",
  "severity": "NORMAL|WARNING|CRITICAL|UNKNOWN",
  "summary": "...",
  "hypotheses": [{ "description": "", "supporting_evidence": [], "contradicting_evidence": [], "missing_evidence": [] }],
  "recommended_next_inspection": ["..."],
  "tool_calls": [{ "round": 1, "tool": "get_rack_profile", "args": {}, "status": "SUCCESS|ERROR", "result_summary": "" }],
  "investigation_status": "COMPLETED|INCOMPLETE|FAILED",
  "model": "nvidia/...",
  "generated_at": "ISO"
}
```

Each event in `events` has the form `{ type: START|MODEL|TOOL|REPORT|ERROR|END, timestamp, tool?, description, status: SUCCESS|ERROR|INFO }`. The events are recorded while the graph runs. They are not generated afterwards, and they never contain model reasoning text.

## Tools (read-only)

| Tool | Args | Returns |
|---|---|---|
| `get_current_telemetry` | `rack_id`, `metric_type?` | Readings with full provenance, `age_minutes`, `stale`, and `missing_metrics` |
| `get_telemetry_history` | `rack_id`, `metric_type`, `limit?` (default 10, max 50) | Observations **oldest to newest**, plus stats (first/last/min/max/change). Returns `available:false` when there is no history |
| `get_rack_profile` | `rack_id` | Equipment type and fictional thresholds |

Tool results are capped at 8,000 characters. When a history result is too large, the oldest observations are dropped first and the output stays valid JSON.

## Scenarios (all simulated)

| Fixture | Situation |
|---|---|
| `a-normal` | Network rack. Temperature and humidity are well inside the profile limits |
| `b-elevated` | Compute rack at 29.6 C, which is above the 27 C warning and below the 33 C critical threshold. The temperature is rising |
| `c-critical` | Compute rack at 35.4 C, above the 33 C critical threshold. The temperature has risen steadily and SOUND_RAW is climbing |
| `d-stale` | Storage rack. The only reading is a temperature from 3 hours ago, and there is no history |
| `B2` (demo only) | The same readings as B under a Network profile with a 32 C warning threshold, to show that the interpretation depends on the profile |

## Known limitations

- Tools read from the snapshot in the request. SpacetimeDB integration is not wired up yet.
- Severity follows a fixed policy: the profile thresholds applied to fresh readings (`thresholdSeverity` in `tools.ts`). Nemotron is told this severity before it writes the report. If its output still disagrees, the policy value wins, and a `Severity adjusted` event appears in the timeline. Nemotron chooses the investigation steps, the hypotheses and the recommendations.
- `nvidia/nemotron-3-super-120b-a12b` returned 404 for our key, so the default model is `nemotron-3.5-super-vl-120b-a12b`. Tool calling on that model was verified on 2026-11-07.
- The investigation is synchronous. There is no streaming endpoint; the timeline comes back in the response.
