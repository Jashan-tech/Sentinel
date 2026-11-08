# SENTINEL

**Autonomous data center inspection and failure prevention: live rack telemetry plus a team of AI agents that investigate the problems the telemetry reveals.**

Built for HackUTD 2026, targeting three tracks:

| Track | How SENTINEL addresses it |
|---|---|
| **NorthMark Compute & Cloud (NMC²)** | Data center teams can detect threshold problems early, investigate them, and get evidence-backed next steps |
| **NVIDIA: Nemotron Beyond a Chatbot** | A Supervisor and five specialist agents run on NVIDIA Nemotron, including a Vision Agent that inspects real rack photographs. Each agent plans, calls tools or looks at the image, and has its findings verified, rather than just answering a chat message |
| **SpacetimeDB** | SpacetimeDB is the only backend. It holds telemetry, alerts, profiles and AI investigation records, and syncs them in real time to every connected dashboard |

All telemetry in this demo is **simulated**. The values match what the rover's sensors could actually measure. All rack thresholds are fictional demo settings, not manufacturer specifications.

---

## How it works

```
 Rover / simulator ──reducers──▶ ┌────────────────────────┐ ◀──subscriptions── Dashboard (React, :5173)
                                 │  SpacetimeDB  (:3000)  │                         │
                                 │  telemetry · alerts ·  │ ◀─start/complete────────┤  "Run AI Investigation"
                                 │  profiles · AI reports │      investigation      │
                                 └────────────────────────┘                         │ POST /api/agent/investigate
                                                                                    ▼  (Vite proxy)
                                                     Nemotron agent service (Express + LangGraph, :3001)
                                                     Supervisor → Telemetry / Environment / Documentation → Verification
```

1. **Telemetry arrives.** The simulated rover submits readings through SpacetimeDB reducers. Readings are validated, stored and synced live.
2. **Alerts fire.** Fixed threshold rules run inside SpacetimeDB and raise WARNING and CRITICAL alerts.
3. **An operator starts an investigation.** On the dashboard, **Run AI Investigation** sends the selected rack's current data to the agent service.
4. **The agents investigate.** A Nemotron Supervisor plans the work and delegates to specialist agents. They call read-only tools against that data. When an operator attaches a photo (**Run Visual Inspection**), a Vision Agent inspects the actual image. A Verification agent checks every agent's claims, including looking at the photo itself.
5. **Everyone sees the result.** The report and execution timeline are saved in SpacetimeDB and appear in every open dashboard.

---

## Quick start

### Prerequisites
- Node.js 24 or later, and npm
- SpacetimeDB CLI **2.14.1**. Install it with `curl -sSf https://install.spacetimedb.com | sh` (macOS/Linux) or the Windows installer, then add `~/.local/bin` to your `PATH`.
- An NVIDIA API key from https://build.nvidia.com (free). Only the agent service needs it.
- Google Chrome or Microsoft Edge, only for the automated browser tests.

### First-time setup
```bash
npm ci                               # root workspaces: spacetimedb + dashboard
cd agent && npm install && cd ..     # agent service
cp agent/.env.example agent/.env     # then set NVIDIA_API_KEY=nvapi-... (never commit .env)

npm run db:start                     # terminal 1: SpacetimeDB on 127.0.0.1:3000 (leave running)
npm run db:build                     # terminal 2: typecheck + build the module
npm run db:publish                   # publish database "sentinel"
npm run db:generate                  # regenerate dashboard client bindings
npm run agent:register               # authorize the agent service to record reports (writes agent/.env)
```

`agent:register` gives the agent service its own SpacetimeDB identity and authorizes it. Run it as the identity that published the database, which is your SpacetimeDB CLI login. On a database published before this change, it first claims the admin role once for that identity. Restart the agent afterwards. Without it, investigations fail with "Agent cannot record investigations".

### Run the app (three terminals)
```bash
npm run db:start                     # 1. SpacetimeDB          → :3000
cd agent && npm start                # 2. Nemotron agent        → :3001
npm run dev                          # 3. Dashboard             → http://127.0.0.1:5173
```

Data persists in `.spacetime/`, so you don't need to publish again on later runs. Start only one SpacetimeDB server on port 3000.

### Five-minute demo
1. Open http://127.0.0.1:5173 in two browser windows, one normal and one private. Both should say **Connected**.
2. Select **Rack 01** (Standard Network profile, 32 °C warning / 40 °C critical). Submit **41.5 °C**. Both windows show the reading and a **CRITICAL** alert.
3. Click **Run AI Investigation**. Both windows show *Running*. After about 25–40 s, both show the same report: severity, diagnosis, measured facts, AI hypotheses, verification results, missing evidence, next inspections, and the agent timeline.
4. Switch the profile to **Industrial** (40 °C warning / 50 °C critical) and click **Apply profile**. The alert drops to **WARNING**. Run another investigation: the new report reflects the new thresholds, and the first one is still in **History**.
5. Notice that sound and distance were never submitted. They stay *Unavailable*, and the AI report lists them as missing rather than inventing values.
6. **Visual inspection:** in the AI investigation panel, choose a photo from `agent/test-assets/vision/` (for example `rack-switches-patch-panels.jpg`) and set the source to **Online reference**. Paste its source URL, creator and license from that folder's `manifest.json`, then click **Run Visual Inspection**. After about 30–70 s, both windows show the image's provenance and preview, the Vision Agent's observations (each marked certain or uncertain, with limitations), and Verification's verdict on which visual claims are unsupported.

---

## The dashboard

The app is one page. The left sidebar selects a rack, and every section updates for the selected rack.

| Section | Purpose | Source |
|---|---|---|
| Rack header | Name, location, equipment type, profile, demo thresholds | Feature 1 |
| Live telemetry cards | Temperature, humidity, sound (raw), ultrasonic distance. Each shows its source, observed and ingested times, and a Fresh / Stale / No data badge | Feature 1 |
| Submit a simulated reading | Manual stand-in for the rover, one reading per submission. Also changes the rack profile | Feature 1 |
| Active alerts | Fixed threshold rules evaluated inside SpacetimeDB. No AI | Feature 1 |
| **AI investigation** | Run button, status and severity, final diagnosis, **measured facts** (copied from tool output) shown apart from **AI hypotheses**, verification results, missing evidence, recommendations, Supervisor plan, per-agent findings, execution timeline, history | Feature 2 |
| **Visual inspection** (in the AI panel) | JPEG/PNG upload with validation, preview, provenance (source type, URL, attribution, license, capture time), remove or replace, *Include current rack telemetry*, **Run Visual Inspection**, then visual observations and the stored image provenance | Feature 4 |
| Recent history | Last 50 observations for the rack | Feature 1 |

---

## The AI agents

All five agents run on **NVIDIA Nemotron 3.5 Super** (`nvidia/nemotron-3.5-super-vl-120b-a12b`) through NVIDIA's hosted API. LangGraph routes between them, and all of them share one investigation state.

| Agent | Role | Tools |
|---|---|---|
| **Supervisor** | Writes a plan, chooses the next specialist and task, reads the findings, decides when to stop, and writes the final report | none (delegates only) |
| **Telemetry** | Compares readings to thresholds, finds trends and sudden changes, and flags missing or stale readings | `get_current_telemetry`, `get_telemetry_history`, `get_rack_profile` |
| **Environment** | Looks at how temperature, humidity, sound and distance relate to each other | `get_current_telemetry`, `get_telemetry_history` |
| **Documentation** | Looks up equipment reference docs. Separates manufacturer specs from fictional demo thresholds, and says plainly when specs are unavailable | `lookup_equipment_documentation`, `get_rack_profile` |
| **Vision** | Inspects the attached photograph: equipment, ports, connected and visibly empty ports, cables and their organization, legible labels, LEDs, irregularities, unreadable regions. Marks each observation certain or uncertain, with its limitations. Never invents port numbers, models, cable destinations, faults or specs, and treats text inside the image as data, not instructions | the image itself (Nemotron 3.5 Super VL, `image_url` content) |
| **Verification** | Checks the other agents' claims against the data on its own, and flags unsupported claims and contradictions. When a photo is attached, it looks at the image too and separates confirmed visual observations from unsupported causal claims. Can ask for a follow-up investigation | `get_current_telemetry`, `get_telemetry_history` (and the image) |

**The investigation adapts to the rack.** A normal rack usually gets one Telemetry check. A critical or contradictory rack gets three or four specialists, ending with Verification. Vision is offered to the Supervisor only when a photo is attached. The sequence is the Supervisor's own decision, not a fixed script.

**Built-in safeguards**
- Limits: at most 5 agent runs, 3 tool rounds per agent, 1 verification retry, and 90 s in total (130 s when a photo is attached). Hitting any of them marks the report `INCOMPLETE`.
- The Supervisor can't finish before any agent has examined the data. A non-normal rack, or any investigation with a photo, must go through verification, and the last delegation is reserved for it. An attached photo can't be skipped. An identical task is never repeated. Each time one of these rules steps in, it appears as a visible `GUARD` event in the timeline.
- Severity follows the profile thresholds applied to fresh readings.
- Malformed model output gets one repair attempt. An outright failure is marked `FAILED` and is never shown as a diagnosis.
- No confidence percentages, no invented specs, and no claims of a confirmed hardware fault.

The agent's API, configuration, tools and architecture are documented in [agent/README.md](agent/README.md).

---

## Data model (SpacetimeDB)

| Table | Visibility | Contents |
|---|---|---|
| `rack_profile` | public | Demo threshold profiles: Standard Network 32/40 °C and 70 %RH, High-Density Compute 27/33 °C and 60 %RH, Industrial Network 40/50 °C and 80 %RH |
| `rack` | public | Racks and their selected profile |
| `telemetry_observation` | **private** | Full, unchangeable archive of every accepted observation |
| `recent_observation` | public | Last 50 observations per rack. When full, the oldest row of the (metric, source) group with the most rows is evicted, so a fast sensor can't push slower sensors or other metrics out |
| `current_telemetry` | public | Latest reading per rack and metric, keyed `rackId:metricType` |
| `rack_alert` | public | One alert slot per rack and metric: severity, message, active flag, resolution time |
| `investigation` | public | One row per AI investigation: status, severity, the profile at run time, whether telemetry was simulated, the request snapshot, report JSON, events JSON, who submitted it, created and completed times. **Image bytes are rejected** |
| `investigation_completion` | public | Who recorded each finished investigation: `AGENT` (the authorized agent service), `CLIENT_ABANDONED` (the browser that started it gave up) or `DATABASE_EXPIRED` (no result within 5 minutes) |
| `admin_account`, `agent_authorization`, `module_setting`, `investigation_expiry` | **private** | The database admin, the agent identities allowed to record reports, admin settings, and the schedule for the stale-investigation sweep |
| `investigation_image` | public | Provenance of an investigation's photo: image ID, filename, type, source type, capture time (only if known), server upload time, source URL, attribution, license, SHA-256, size, dimensions, and a JPEG preview of at most 60 KB. The full image is not stored |

| Reducer | Purpose |
|---|---|
| `ingest_simulated_observation` | Validates and stores one reading, keeps the recent and current tables up to date, and re-evaluates alerts. All of it happens in one transaction |
| `change_rack_profile` | Changes a rack's profile and re-evaluates its current values |
| `initialize_demo` | Seeds missing demo profiles and racks. Safe to run more than once |
| `start_investigation` | Records a `RUNNING` investigation. The server works out the profile and the simulated flag itself. It also expires stale runs on that rack and keeps the newest 20 investigations per rack, never deleting a running one |
| `complete_investigation` | **Authorized agent identities only.** Stores the final report and events after validating them. An identical retry does nothing; a different second result is rejected |
| `abandon_investigation` | Only the identity that started the run. Marks it `FAILED`/`UNKNOWN` with no diagnosis. Does nothing if the run already finished |
| `expire_stale_investigations` | Scheduled every 60 s, not callable by clients. Marks `RUNNING` investigations older than the timeout (default 300 s) as `FAILED` |
| `claim_admin`, `authorize_agent`, `revoke_agent`, `set_running_timeout` | Admin setup. `init` makes the owner admin on new databases; `claim_admin` works only while there is no admin yet |
| `attach_investigation_image` | Stores a running investigation's image provenance. Only the identity that started it can call this, and only once |

**Design notes (Feature 1)**
- `ingested_at` always comes from the server clock. `observed_at` comes from the caller.
- A delayed observation still enters history but never replaces a newer current value. When two readings share a timestamp, the first one is kept.
- The recent table keeps 50 rows per rack, shared fairly between metrics and sources, so dashboard subscriptions stay small. The private archive is never trimmed.
- Changing a profile re-evaluates the current values without rewriting any observations.
- Freshness is shown on its own. It never implies health, resolves an alert, or fills in a missing reading.

---

## Measurement and trust contract

| Metric | Unit | Valid range | Real hardware it maps to |
|---|---|---|---|
| `AMBIENT_TEMPERATURE_C` | `°C` | −50 to 100 | Rover temperature sensor |
| `RELATIVE_HUMIDITY_PERCENT` | `%RH` | 0 to 100 | Rover humidity sensor |
| `SOUND_RAW` | `raw` | ≥ 0 | Raw sound level, **not calibrated decibels** |
| `ULTRASONIC_DISTANCE_CM` | `cm` | ≥ 0 | HC-SR04 distance sensor |

**Accepted readings**
- Only `sourceType = SIMULATOR` is accepted.
- Observation timestamps may be at most 30 s in the future.
- Unknown metrics or racks, mismatched units, NaN or infinite values, and source impersonation are all rejected.

**Never invented:** fan RPM, CPU, power, network errors, audio and fault classifications. The rover can't measure them, so neither the dashboard nor the agents claim to have them. Photos come only from an operator upload (the rover camera isn't connected yet), and the Vision Agent reports what is visible, never a cause.

**Images (Feature 4)**
- Only JPEG and PNG are accepted, up to 4 MB and 4096 px per side, and one image per investigation.
- The browser and the agent each check the real file signature, the dimensions and that the image decodes. The agent decodes every pixel, checks PNG checksums and the exact amount of image data, and requires real JPEG scan data. The declared type is never trusted on its own.
- The agent computes the SHA-256 of the bytes it actually received.
- Source URLs are stored as metadata only and are **never fetched** by the server.
- Capture time is stored only when the operator supplies it.
- Online reference images are labelled "not captured by SENTINEL".
- The image bytes go to the agent and the NVIDIA API for that one inference and are not kept. Only the hash, the provenance and a small preview are stored, so a stored report can outlive its image.
- A Raspberry Pi camera can later use the same `POST /investigate` request with `source_type: "ROVER_CAMERA"` and a real capture time. The Vision Agent won't need changes.

**Access control (local demo only)**
- Any connected identity can submit readings, change profiles, start investigations, or abandon its own run.
- Only the agent identities authorized by the admin can record an investigation report.
- Source identifiers are labels supplied by the user. `submitted_by` records the identity that actually submitted.
- This is not production access control. Keep the server bound to loopback.

**AI investigation records**
1. The browser stores the request snapshot (`start_investigation`) and the image provenance.
2. It sends the agent only the investigation ID and the image bytes.
3. The agent loads the **stored** snapshot from SpacetimeDB and checks the image against the recorded SHA-256. It then runs the investigation and records the report itself with `complete_investigation`, under its own authorized identity.
4. The browser can't submit a report. If the agent can't be reached or can't record the result, the browser can only mark its own run `FAILED`/`UNKNOWN`. If nobody records anything, the database expires the run after 5 minutes.

SpacetimeDB checks every report before storing it:
- the report is for the investigated rack
- the JSON is well-formed and within the size limits, with the required fields present and no image bytes
- status and severity match the report
- `COMPLETED` only with `VERIFIED` (or not required) verification and no incomplete reasons; `INCOMPLETE` and `FAILED` must say why
- the run is still `RUNNING`

`investigation_completion` records who wrote each final state. The profile and the simulated flag come from the database's own tables.

The agent's SpacetimeDB token and the NVIDIA key stay in `agent/.env` on the server, and the browser reaches the agent only through the Vite `/api/agent` proxy. Reports are still AI advisory output, not confirmed diagnoses.

**Report and image data in browsers**
- Each rack keeps its newest 20 investigations, together with their image rows and completion rows. That bounds what a dashboard subscription downloads, at about 20 × (report up to 200 KB + preview up to 60 KB) per rack.
- Investigation rows and image previews are **public**: any client connected to this database can read them. Both browsers need them to stay in sync, and the demo has no user accounts. Don't upload photos you wouldn't show everyone with access to the database. Full images are never stored.

---

## Configuration

| Where | Setting | Default |
|---|---|---|
| `agent/.env` | `NVIDIA_API_KEY` | required |
| `agent/.env` | `NVIDIA_MODEL`, `NVIDIA_SPECIALIST_MODEL` | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| `agent/.env` | `MAX_DELEGATIONS`, `MAX_SPECIALIST_TOOL_ROUNDS`, `MAX_VERIFICATION_RETRIES`, `MAX_INVESTIGATION_SECONDS`, `MAX_VISUAL_INVESTIGATION_SECONDS` | 5, 3, 1, 90, 130 |
| `dashboard/.env.local` | `VITE_SPACETIME_URI`, `VITE_SPACETIME_DATABASE` | `ws://127.0.0.1:3000`, `sentinel` |
| environment | `AGENT_URL` (target of the Vite proxy) | `http://127.0.0.1:3001` |
| environment | `SPACETIME_CLI` (CLI path, if not on PATH) | `spacetime` |

The dashboard's freshness setting (30 s, 60 s or 5 min) is sent with each investigation, so the agents judge staleness by the same window the operator sees.

---

## Equipment intelligence and early warnings (Feature 5)

The existing agent tools now calculate deterministic per-sensor trends from subscribed observation history and produce separate observed-condition, early-warning, and data-quality indicators. The dashboard shows the actual observation window, units, source provenance, statistics, and rule evidence alongside the existing AI report. Three distinct official manufacturer documents (Cisco, Dell, HPE) provide four concise section records with exact model applicability, citations, and limitations.

Installed equipment identity is **optional explicit operator input per investigation**. Generic rack profiles and online reference photos never identify installed hardware. Without an exact confirmed manufacturer/model match, documentation returns **NO_MATCH** and model-specific guidance remains unavailable. Identity and evidence persist through the existing SpacetimeDB snapshot/report records; no new database, agent, or unbounded history subscription was added.

Trend rules require at least 3 samples over 60 seconds with at most 120 seconds between adjacent samples. Two-point changes are descriptive, never sustained trends. All thresholds/tolerances remain demonstration rules. Neither trends nor photos establish faults or failure forecasts.

See [the full equipment-intelligence contract and source registry](agent/EQUIPMENT_INTELLIGENCE.md) for rules, API fields, supported models, trust limits and live verification steps. Run `npm run test:equipment-e2e` after `npm run db:verify:publish` for actual backend/two-browser integration with **explicitly scripted model responses**, not live NVIDIA inference. Feature 5 live inference was not run here because no NVIDIA key was configured.

---

## Testing

| Command | What it covers | Last result |
|---|---|---|
| `npm test` | SpacetimeDB rules, investigation-record validation (rack match, structure, verification consistency), abandon and expiry records, retention, fair eviction, image provenance, and the rule that rows never contain image bytes | 42/42 pass |
| `npm run typecheck` / `npm run build` | Module, dashboard and scripts / production dashboard build | pass |
| `npm run db:verify:publish && npm run test:integration` | Checks against the real backend on the separate `sentinel-verification` database, including forged, mismatched, duplicate and unauthorized completions, abandonment, expiry, retention and fair eviction | 27/27 pass |
| `npm run test:browser` | Feature 1 two-browser sync, reload, offline/reconnect, mobile layout. Needs Microsoft Edge and a second dev server on :5174 (see below) | pass (run on Chrome on macOS) |
| `cd agent && npm test && npm run typecheck` | Agent tools, single- and multi-agent graphs with **scripted** models: input validation matching the database, mandatory visual verification, report integrity, history statistics, enforced deadlines and cancellation, full image decoding, evidence deduplication, source filtering, and recorded (persisted) mode | 167/167 pass |
| `npm run test:equipment-e2e` | Real SpacetimeDB plus two browsers plus the agent's HTTP and LangGraph code with **scripted** model responses; the agent records the report under its own authorized identity | pass |
| `npm run test:agent-e2e` | **Live** end to end: two Chrome sessions, a critical reading on Rack 01, a real Nemotron multi-agent investigation, storage in SpacetimeDB checked over SQL, sync between sessions, profile change and rerun, missing data, and failure handling | all 14 steps pass |
| `npm run test:vision-e2e` | **Live** vision end to end: rejection of invalid uploads, upload of a real reference photo with provenance, a combined telemetry + vision investigation on real Nemotron VL, a hash check of the received bytes, verification of visual claims, storage in SpacetimeDB (provenance only), sync to a second browser, and an outage recorded as FAILED | pass |
| `cd agent && npm run demo` | Live multi-agent runs on the sample scenarios (normal, critical, stale, contradictory) | pass |

Browser test setup: keep `npm run dev` on 5173, then run `VITE_SPACETIME_DATABASE=sentinel-verification npm run dev -w dashboard -- --port 5174` in another terminal. In PowerShell, set it with `$env:VITE_SPACETIME_DATABASE='sentinel-verification'` first. That test expects demo **Rack 03** in the main database to have no readings, so leave it untouched.

The module build may print `tsc not found in node_modules`. This is harmless: TypeScript is installed at the workspace root, and `db:build` runs all the type checks first.

---

## Repository layout

```
spacetimedb/          SpacetimeDB module: tables, reducers, rules, investigation validation, tests
dashboard/            React + Vite dashboard
  src/RackView.tsx            telemetry, simulator, alerts, history
  src/InvestigationPanel.tsx  AI investigation panel
  src/investigation.ts        adapter from SpacetimeDB rows to the agent request, plus response validation
  src/imageUpload.ts          browser-side image validation, hashing and preview
  src/module_bindings/        generated by `npm run db:generate` (do not edit)
agent/                Nemotron multi-agent investigation service (see agent/README.md)
  test-assets/vision/         6 Wikimedia Commons reference photos + manifest.json (license, creator, sha256) + review guide
scripts/              CLI helper, backend integration test, browser tests, live agent end-to-end test
```

---

## Known limitations

- All telemetry is simulated. Rover hardware, the rover camera and infrastructure integrations such as Redfish, IPMI or SNMP are not implemented.
- The Vision Agent can misread small details, and results vary between runs. In live tests it once placed an LED at the wrong port and once described an orange light as white. That's why visual findings are labelled AI observations, carry a certainty, and go through Verification. They are never treated as faults.
- An online reference photo doesn't show the rack under investigation. The agents say so, but a real deployment needs rover-camera images.
- The agent tools read the snapshot captured when you click Run. They don't query SpacetimeDB directly while the investigation runs.
- Agent authorization relies on SpacetimeDB identities on a local server. On a database published before this change, `claim_admin` goes to whoever calls it first. Run `npm run agent:register` right after publishing, and keep the server on loopback.
- Investigation reports and image previews are readable by every client connected to the database. There are no per-user permissions.
- An investigation takes about 30–110 s and nothing streams in the meantime. If the browser closes, the agent still finishes and records the result. If the agent dies, the database marks the run `FAILED` after 5 minutes.
- Combined telemetry-plus-photo runs can hit the 130 s budget. The report is then `INCOMPLETE` and says why.
- Manufacturer guidance is limited to the exact supported identities in the curated source registry. Unknown identities receive NO_MATCH. Rover ambient telemetry cannot automatically establish manufacturer operating compliance.
- Access control is suitable only for a local demo.
- `npm run test:browser` and `npm run test:equipment-e2e` default to Microsoft Edge. Set `E2E_BROWSER_CHANNEL=chrome` to use Chrome.

## References

- SpacetimeDB: [TypeScript quickstart](https://spacetimedb.com/docs/quickstarts/typescript/) · [Tables](https://spacetimedb.com/docs/tables/) · [Reducers](https://spacetimedb.com/docs/functions/reducers/) · [TypeScript client](https://spacetimedb.com/docs/clients/typescript/) · [Subscriptions](https://spacetimedb.com/docs/clients/subscriptions/). Where these docs differed from the installed 2.14.1 type declarations, the declarations were followed.
- NVIDIA hosted models: https://build.nvidia.com · LangGraph JS: https://langchain-ai.github.io/langgraphjs/
