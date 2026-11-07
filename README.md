# SENTINEL — Feature 1

Real-time data center environmental telemetry, backed by **SpacetimeDB 2.14.1** and a React + Vite + TypeScript dashboard. This feature contains deterministic monitoring rules, not AI diagnoses. No physical hardware or infrastructure integrations are implemented.

## Start locally (PowerShell)

Prerequisites: installed SpacetimeDB CLI **2.14.1**, npm, and Node.js. The SDK's declared Node engine is `^22.23.4 || ^24.22.1 || >=26.12.1`; prefer a version satisfying it. The supplied Node **24.11.1** / npm **10.4.0** environment was used for the verification below, despite npm's engine warning. No Rust is required.

From `C:\Dev\SENTINEL`:

```powershell
npm ci
# Only if no SpacetimeDB server is already listening on port 3000:
npm run db:start
```

In a second terminal:

```powershell
cd C:\Dev\SENTINEL
npm run db:build
npm run db:publish
npm run db:generate
npm run dev
```

Open **http://127.0.0.1:5173** in two separate browser sessions. The default database is `sentinel`. New databases seed three fictional profiles/racks and **zero readings**. There is no continuous simulator. Commit individual measurements using Submit; changing a text field alone sends nothing. Apply profile reevaluates existing current temperature/humidity against that profile's thresholds.

The CLI helper uses `SPACETIME_CLI` if set, otherwise the Windows `%LOCALAPPDATA%\SpacetimeDB\spacetime.exe` installation or `spacetime` on PATH. `db:start` binds to loopback and keeps persistent data in ignored `.spacetime/`. If using a different existing server data directory, continue using that server's start command. Do not run two servers on the same port or delete the data directory.

Optional dashboard settings are in `dashboard/.env.example`; copy to ignored `dashboard/.env.local` and restart Vite to override them. Freshness defaults to **60 seconds** and is selectable as 30, 60, or 300 seconds. This setting and form drafts are local UI preferences, not persisted telemetry. The one-second display timer updates observation ages locally; it never fetches data.

## Architecture and files

| File / directory                         | Responsibility                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `spacetimedb/src/index.ts`               | Tables, idempotent seed, transactional ingestion, profile changes, alert lifecycle |
| `spacetimedb/src/rules.ts`               | Strict measurement/provenance/time validation and threshold rules                  |
| `spacetimedb/tests/rules.test.ts`        | Numeric, timestamp, unit, source, and threshold boundary tests                     |
| `dashboard/src/App.tsx`                  | Connection status, rack selector, subscribed configuration                         |
| `dashboard/src/RackView.tsx`             | Rack-scoped subscriptions, simulator forms, current values, alerts, recent history |
| `dashboard/src/telemetry.ts`             | Presentation definitions for the four supported measurements                       |
| `dashboard/src/module_bindings/`         | Official CLI-generated 2.14.1 client bindings; regenerate after module changes     |
| `dashboard/src/main.tsx`, `style.css`    | Official SDK provider, responsive dark UI                                          |
| `scripts/integration.ts`                 | Real backend reducer, validation, history, and two-client synchronization checks   |
| `scripts/browser.ts`                     | Two independent Edge contexts exercising actual dashboard subscriptions            |
| `scripts/spacetime.mjs`                  | Portable CLI lookup, without requiring a shell alias                               |
| Root `package.json`, `package-lock.json` | npm workspaces, commands, reproducible dependency versions                         |

SpacetimeDB is the sole backend and source of truth. Clients write through exported reducers and read through official SDK subscriptions. Each ingestion transaction validates input, appends the immutable private archive, maintains the bounded recent table, conditionally advances current state, and evaluates relevant alerts. A failed reducer commits none of these changes. There is no REST backend, additional WebSocket server, frontend polling, or fallback telemetry.

Tables use camelCase accessors in TypeScript and generated snake_case SQL names. Keys and filters are indexed. `rack_profile` and `rack` store configuration; `telemetry_observation` is private, immutable historical storage. `current_telemetry` uses a stable `rackId:metricType` primary key; strictly newer observation times advance it. Delayed observations still enter history. Equal observation timestamps retain the first accepted current value. `ingested_at` always comes from `ctx.timestamp`, distinct from caller-provided `observed_at`. The backend records authenticated `ctx.sender` as `submitted_by`, never accepting an identity argument.

### Bounded history and alert trade-offs

The public `recent_observation` table is a transactional projection containing at most **50 observations per rack**, ordered by ingestion time with observation ID as a deterministic tie-breaker. Ingestion scans only that rack's maximum 51 recent rows before eviction, irrespective of archive size. It duplicates at most 50 rows per rack, keeping dashboard subscriptions bounded without relying on `ORDER BY ... LIMIT` subscription support. The private archive is never pruned or rewritten by application code. An owner can inspect it with CLI SQL; there is no full-history dashboard or public archive API in Feature 1.

The dashboard subscribes to small configuration tables and rack-filtered current, recent, and alert tables using the generated query builder and `useTable`. The official hooks own subscription cleanup, including component unmounts on rack changes; the provider owns connection cleanup/reconnects. No subscription selects the unbounded archive. Readiness gates mutations during synchronization; promises resolve on backend acknowledgement before a committed message appears. Offline cached readings are marked Offline rather than presented as live data.

`rack_alert` has one stable slot per rack/metric. Severity/message update without duplicating active alerts; recovery sets `active=false` and a server resolution time. A later episode reuses the slot with a new creation time. Complete alert episode history is not retained. Temperature has warning/critical thresholds, humidity has a high warning threshold; sound and distance have no alert rules. Profile changes reevaluate current values transactionally without rewriting observations. Freshness is shown independently and does not imply health, resolve an alert, or manufacture a missing reading.

### Measurement and trust contract

| Metric                      | Exact reducer unit | Validation                                | Real acquisition compatibility                                |
| --------------------------- | ------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| `AMBIENT_TEMPERATURE_C`     | `°C`               | Finite, −50 through 100 °C                | Rover temperature sensor                                      |
| `RELATIVE_HUMIDITY_PERCENT` | `%RH`              | Finite, 0 through 100                     | Rover humidity sensor                                         |
| `SOUND_RAW`                 | `raw`              | Finite, 0 through JS maximum safe integer | Raw sound sensor output; **not calibrated decibels or audio** |
| `ULTRASONIC_DISTANCE_CM`    | `cm`               | Finite, 0 through JS maximum safe integer | HC-SR04 distance measurement                                  |

These are generic ingestion sanity bounds, not guarantees of sensor accuracy or specific hardware ranges; sensor models/calibration are not finalized. Ultrasound readings beyond a particular device's useful range require device-side handling in a later integration. No fan RPM, CPU, power, network, recorded audio, frequency analysis, camera, or fault classification data is invented.

The only write path is `ingest_simulated_observation`, and **only `sourceType='SIMULATOR'` is accepted**. Unknown metrics/racks, mismatched units, invalid numeric values, negative raw/distance values, and source impersonation are rejected server-side. Source labels must be nonblank and at most 100 characters. Observation timestamps must be positive and at most **30 seconds ahead of server time**; old observations are deliberately allowed and shown stale. Clock synchronization is the local operator's responsibility.

SpacetimeDB supplies each connection an authenticated identity. In this trusted **local demonstration**, any connected identity can submit simulated readings, change rack profiles, or invoke idempotent initialization. Source identifiers are user-supplied labels, not verified device identities; `submitted_by` supplies the actual caller provenance. Configuration, current values, bounded recent data, and alerts are publicly readable to connected clients. The immutable archive is private to module logic and the database owner. This is **not production access control**. Bind the local server to loopback; no production login or hardware authorization is claimed.

Profiles A/B/C are Standard Network (32/40 °C, 70 %RH), High-Density Compute (27/33 °C, 60 %RH), and Industrial Network (40/50 °C, 80 %RH). Every threshold is a fictional demonstration configuration. Initialization inserts missing records only and does not overwrite a rack's selected profile or create readings.

## Reproduce verification

```powershell
npm test
npm run typecheck
npm run build
npm run db:build
npm run db:publish
# Dedicated test database; no writes to the main sentinel demonstration:
npm run db:verify:publish
npm run test:integration
```

Integration tests use two independent SDK connections and actual reducer calls. They check missing data on untouched rack 3, provenance, independent timestamps, invalid inputs, alert boundaries/recovery, profile reevaluation, idempotent seed, delayed/tied readings, transactional rejection, bounded recent eviction, and archive preservation through privileged CLI SQL. Run them against the dedicated `sentinel-verification` database; tests write rack 1 and retain test history. They can be repeated; don't manually write rack 3 in that database. `TEST_DATABASE`, `SPACETIME_URI`, and `SPACETIME_CLI` can override the integration target/tool. SQL archive checks expect the local server and CLI owner identity used to publish.

For the browser check, leave the normal `npm run dev` on port 5173 and launch another terminal:

```powershell
$env:VITE_SPACETIME_DATABASE='sentinel-verification'
npm run dev -w dashboard -- --port 5174
```

Then run in another terminal (installed Microsoft Edge is used; no browser download required):

```powershell
npm run test:browser
```

The script checks main demo rack 3's empty state, then uses port 5174 for mutations in the isolated database. It verifies two independent browser contexts synchronize temperature, alerts, profiles, and history; reload persistence; repeated rack switching; stale distance; offline/reconnect; and mobile overflow. Its offline step closes the actual test browser socket while network access is disabled, since Chromium offline emulation alone leaves established sockets open. All readings still come from the real SpacetimeDB server. Screenshots are saved to ignored `test-results/`. Do not manually populate demo rack 3 before running the empty-state assertion.

Recorded verification on Windows: **29/29 rule tests**, **15/15 backend integration checks**, successful full TypeScript checks, Vite production build, SpacetimeDB module build/publication, and successful two-context Edge browser verification. The CLI's module build may print `tsc not found in node_modules` because TypeScript is hoisted to the workspace root; `db:build` explicitly runs all TypeScript checks first, including the server module. The npm SDK engine warning on Node 24.11.1 remains a compatibility limitation; use a declared-supported Node version for a new setup.

### Manual two-browser checklist

1. Open port 5173 in a normal window and a separate private window. Both must say Connected and show three racks. On a fresh database, all four cards say Unavailable.
2. On Rack 01 / Standard profile, enter 32 °C and Submit. Both windows must show the simulated value, provenance, observation/ingestion times, a WARNING, and the observation in history. No value changes merely from typing.
3. Submit 40 °C: one active temperature alert becomes CRITICAL. Select Industrial and Apply profile: both windows show that profile, and the existing 40 °C value becomes WARNING. Return to Standard and verify CRITICAL again.
4. Submit 25 °C: the temperature alert resolves. Submit 70 %RH to create humidity WARNING, then 50 %RH to resolve it. Sound and distance submissions do not create diagnostic alerts.
5. Submit an older temperature observation using Observation time: history grows while the newer current value remains. Leave one metric unobserved to confirm it stays Unavailable. An old distance reading becomes Stale. Change freshness threshold locally.
6. Reload the other window: current state/history still come from SpacetimeDB. Switch racks repeatedly; no readings leak between racks. Stop/restart the local server using the same data directory: disconnected state disables writes, reconnection restores persisted state.
7. Use `npm run test:integration` for authoritative server rejection of NaN/infinity, bad units/metrics/timestamps, unknown rack/profile, source impersonation, archive immutability, and recent-window eviction. Browser input validation is not the security boundary.

## API compatibility references

Before implementation, the installed **2.14.1** CLI version, `init`, `build`, `publish`, `generate`, and `sql --help` were inspected; server/client APIs were also checked against installed `spacetimedb@2.14.1` type declarations and generated bindings. Official documentation currently labels these pages as 2.0.0, so installed declarations were authoritative where details differed (for example `SubscriptionBuilder.onError` receives one context, and reducer calls return `Promise<void>`).

- [Official TypeScript quickstart](https://spacetimedb.com/docs/quickstarts/typescript/)
- [Tables and schema](https://spacetimedb.com/docs/tables/)
- [Transactional reducers](https://spacetimedb.com/docs/functions/reducers/)
- [TypeScript client and React integration](https://spacetimedb.com/docs/clients/typescript/)
- [Subscriptions and lifecycle](https://spacetimedb.com/docs/clients/subscriptions/)

No Feature 2 code, NVIDIA/Nemotron calls, AI orchestration, external infrastructure integrations, or cloud deployment is part of this implementation.
