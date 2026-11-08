# Equipment intelligence (Feature 5)

Feature 5 extends the existing Telemetry, Documentation, Supervisor, and Verification tools. It does not add an agent, database, live monitoring integration, physical sensor, or vector store. Manufacturer references are concise, manually verified JSON fixtures; no source pages are fetched during an investigation.

## Equipment identity and citations

The request can contain this optional field:

```json
"equipment_identity": {
  "manufacturer": "Dell",
  "model": "PowerEdge R7425",
  "provenance": "OPERATOR_PROVIDED",
  "assertion": "Operator identifies this equipment from the selected rack inventory."
}
```

The dashboard requires both fields and an explicit confirmation. Identity is for this investigation of the selected rack, not a permanent rack-wide inventory claim; it is saved in the existing SpacetimeDB snapshot and report. Leaving the fields blank keeps identity unknown. Edits clear confirmation. A generic profile, equipment category, or branding visible in any photograph never selects a manufacturer record. A reference photo may show different hardware entirely.

Only exact manufacturer/model matches (case and whitespace normalized) select manufacturer facts. There are no prefix matches, inferred aliases, generation guesses, or automatic profile-to-model mappings. Unknown models or unmatched topics return `match_status: NO_MATCH`, missing information, and general inspection guidance. Model arguments cannot override the identity bound to the snapshot. This remains the existing trusted local-demo operator assertion, not authenticated inventory verification.

Each manufacturer fact inherits the document ID, URL, section, revision, access date, supported models, applicability conditions, and limitations in `src/fixtures/docs/equipment-docs.json`. `verified: true` means the reference facts were checked against the official document, **not** that equipment identity, compliance, or a fault was verified. Manufacturer numbers are conditional context; the fictional rack-profile limits remain the only numerical alert thresholds.

The curated set contains **three distinct manufacturer documents**, represented by four section records. Access date for all is **2026-11-07**:

| Record                | Manufacturer / family / supported models                           | Official title and section                                                                                                                                                                                                       | Revision               | Concise supported facts                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CISCO-C9300-LED`     | Cisco / Catalyst 9300 / C9300-24T, C9300-48T, C9300-24P, C9300-48P | [Catalyst 9300 Hardware Installation Guide — Product Overview](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig/Product-overview.html), System LED, Table 8                          | Updated 2026-05-15     | System LED steady green indicates normal operation; blinking green indicates software loading. Amber indicates improper operation. The table names fan or POST failure as possible reasons. |
| `CISCO-C9300-AIRFLOW` | Cisco / Catalyst 9300 / same four explicit models                  | [Same Hardware Installation Guide — Preparing for Installation](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig/Preparing-for-installation.html), Installation Guidelines; Air Flow | Updated 2026-05-15     | Keep vents clear and avoid another device's exhaust at the intake. Recommended wall clearance is 15 cm; adjacent intake-to-exhaust clearance is 30.5 cm.                                    |
| `DELL-R7425-ENV`      | Dell / PowerEdge / PowerEdge R7425 only                            | [Dell EMC PowerEdge R7425 Technical specifications](https://dl.dell.com/topicspdf/poweredge-r7425_reference-guide2_en-us.pdf), pp. 11–12, Tables 8, 9, 13, 14                                                                    | 2019-12, A09           | Standard operation 10–35 °C below 950 m, no direct sunlight; altitude/configuration restrictions apply. Operating humidity 10–80% with maximum dew point 29 °C.                             |
| `HPE-DL380-G11-ENV`   | HPE / ProLiant / ProLiant DL380 Gen11 only                         | [HPE ProLiant DL380 Gen11 QuickSpecs](https://www.hpe.com/psnow/doc/a50004307enw), Technical Specifications, pp. 79–80; version-specific PDF URL is retained in JSON                                                             | 2026-11-02, Version 49 | Standard inlet 10–35 °C at sea level, altitude derating and installed-option restrictions. Operating humidity 8–90%, non-condensing, maximum wet bulb 28 °C.                                |

A static photo cannot establish LED blinking or prove which LED is being observed. An arbitrary port LED cannot be interpreted as the System LED. A rover ambient sensor is not a verified equipment-inlet sensor; relative humidity alone does not establish wet bulb, dew point, or condensation. A single ultrasonic distance does not measure installation clearance. None of these documents supports automatic compliance assessment or a confirmed rack fault. Full manuals are not copied into the repository.

## Deterministic trend contract

`src/trends.ts` consumes the bounded history already captured from SpacetimeDB subscriptions. It supports exactly the existing four metrics. Compatibility aliases `C`/`°C` and `%`/`%RH` are normalized for older agent fixtures; stored SpacetimeDB units remain unchanged. Observations retain their original timestamps and optional database observation IDs.

- Analyze each metric **separately by source type, sensor identifier, and simulated flag**. Never stitch readings from different sensors or simulated/physical sources into one trend.
- Sort by parsed observation timestamps, not ingestion order or lexicographic ISO strings. Timestamp resolution follows the existing adapter's JavaScript millisecond precision.
- Reject nonfinite/out-of-range measurements, bad units/timestamps, future observations relative to `as_of`, blank provenance, and inconsistent simulator flags. Existing backend future tolerance does not make future observations useful evidence before their stated time.
- Identical timestamp/value duplicates contribute one sample. Earliest ingestion and a deterministic row comparison choose its provenance. Conflicting values at one timestamp are excluded; they prevent a sustained-direction label.
- Minimum **3 distinct valid samples**, **60 seconds** from first to last, and **no adjacent valid-sample gap over 120 seconds** are required to label a sustained direction. Eight most recently observed source series per metric are retained; overflow is explicitly counted and produces a data-quality indicator.
- Tolerances are **0.5 °C**, **2 percentage points RH**, **10 raw sound units**, and **2 cm**. A range within tolerance is stable. Increasing/decreasing requires an endpoint change at least the tolerance, at least two directional steps greater than one tenth of the tolerance, and no reversal greater than one tenth of the tolerance. Inconsistent or insufficient data is not labelled stable.
- Results include sample count; first/last timestamps and values; signed `absolute_change = last − first` (raw units, not percent change); elapsed seconds; endpoint change per minute; min, max, arithmetic sample average; direction; breaches; and data quality. Two points may have an endpoint rate but never a sustained direction. A single sample has null change/rate. Missing metrics remain empty.
- `observation_window` records the reference time, observed endpoints, available database IDs and a SHA-256 of the accepted ordered series. Input, excluded, duplicate, conflicting, and omitted counts make coverage explicit. Statistics describe only supplied recent history, not the full private archive.
- Old samples remain usable to describe a **historical** window, with stale status shown. Historical direction never establishes a current warning by itself. No interpolation, equal-frequency assumptions, or extrapolation is performed.

`observed_abnormal_span_seconds` sums intervals bounded by two observed warning breaches only when their gap is at most 120 seconds and no known invalid/conflicting sample lies between them. `longest_abnormal_span_seconds` records the longest such run. Both are null without a qualifying pair. These are **sampled spans**, not proof that the condition remained abnormal between samples. They are never extended to `as_of`. Breach counts use the selected fictional profile; no lower humidity limit or sound/distance health threshold is invented.

## Early-warning rules

Rules are versioned as `sentinel-trends-v1`. Each indicator carries a stable rack/metric/source/rule ID, severity, classification, observed evidence, window, explanation, missing information, and next inspection.

| Classification / rule                       | Trigger                                                                                                                                                                     | Interpretation                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Observed abnormal / current threshold       | Fresh valid current sample at profile warning/critical limit                                                                                                                | WARNING or CRITICAL configured condition; not a hardware fault                 |
| Observed abnormal / repeated threshold      | At least 3 distinct historical warning breaches                                                                                                                             | Historical repeated condition; stale history is explicitly labelled            |
| Early warning / sustained increase          | Eligible increasing temperature or humidity, fresh same-source current reading consistent with the historical endpoint                                                      | Observed trend worth inspecting; not a failure prediction                      |
| Early warning / significant sound change    | At least 2 distinct same-source samples within allowed gaps; absolute endpoint change at least max(100 raw units, 25% of first magnitude); fresh consistent current reading | Uncalibrated sensor change only; no dB, audio analysis or mechanical diagnosis |
| Early warning / significant distance change | Same data-quality requirements; at least 10 cm endpoint change                                                                                                              | Observed distance change only; no obstruction, motion, or collision inference  |
| Data quality                                | Missing/invalid current data; insufficient, contradictory, sparse or stale history; omitted source series                                                                   | UNKNOWN; obtain more evidence rather than treating absence as health           |

Sound/distance two-point changes are explicitly marked as non-sustained. Heuristics and tolerances are fictional demonstration rules, not hardware calibration. A later current reading that contradicts the historical endpoint suppresses a live trend warning; historical breach evidence remains historical. Overall report severity retains the existing current-profile policy; early warnings are separate and require verification before synthesis when budget allows. They do not raise NORMAL to a fabricated fault severity. Budget/time guards still apply.

## Agent integration and persistence

- Telemetry gets `analyze_telemetry_trends` and `get_early_warning_indicators`, each with `rack_id`, `metric_type`, and optional `source_identifier` to narrow bounded results. Numerical trend calculations must come from those tools.
- Documentation keeps `lookup_equipment_documentation(equipment_type, topic?)`, adds LED/airflow topics, and uses identity bound to the snapshot. It cannot accept an identity supplied by the model.
- Verification can independently invoke trends, indicators, profile, and documentation tools. With a photo, it still uses the existing multimodal model path and receives the actual image.
- Supervisor sees deterministic monitoring evidence and documentation matching, and final synthesis receives the same evidence. Trends/indicators and documentation-match records are compiled in code even if the Supervisor selects a minimal route. Full retrieved citations are preserved in `evidence.documentation`.
- The report adds `evidence.trends`, `early_warning_indicators`, `equipment_identity`, and `documentation_match`. Existing SpacetimeDB `snapshot_json`/`report_json` store them unchanged; no new tables or archive subscriptions are needed. Existing old reports remain readable in the dashboard.
- Observed conditions, early-warning trends, AI explanations, and verified equipment faults are distinct concepts. This evidence supports the first two. It does not automatically support the latter two, failure probabilities, remaining useful life, or predicted failure dates.

## Verification

From the root:

```powershell
npm ci
npm ci --prefix agent
npm test
npm run typecheck
npm test --prefix agent
npm run typecheck --prefix agent
npm run build
npm run db:build
npm run db:verify:publish
npm run test:integration
npm run test:equipment-e2e
```

The last command starts and stops its own Vite test server on **5175** and agent test service on an available loopback port. It uses the **actual local SpacetimeDB server**, writes explicit simulated readings only to `sentinel-verification` / rack 1, and opens two independent Edge contexts. It exercises actual HTTP and LangGraph tool loops, the real reference JPEG, unknown identity then confirmed Cisco identity, provenance, numeric results, SpacetimeDB report/snapshot persistence, subscriptions, reload and mobile layout. Model responses are **SCRIPTED TEST RESPONSES**; it does not call NVIDIA or provide a production fallback. Screenshot artifacts go to ignored `test-results/`. Microsoft Edge, root and agent dependencies, and the published verification database are required.

Feature 5 verification in this environment: 92 agent tests, 33 server tests, 15 backend integration checks, both TypeScript projects, dashboard and module builds, isolated module publication, and the two-browser equipment integration test. Live Feature 5 Nemotron inference was **not run**: no `NVIDIA_API_KEY` or `agent/.env` was configured. To check live behavior, configure the existing agent `.env`, start the normal service and dashboard, then run these manual steps:

1. Submit three explicit temperature readings at observation timestamps at least 30 seconds apart, covering 60 seconds, from one simulator identifier. Keep the latest current value fresh. Run an investigation with identity blank: inspect window, rate, provenance, indicators, and NO_MATCH.
2. Attach a reference photo from `test-assets/vision/` with manifest attribution/license. It must not establish model identity. Confirm the reference-image limitation survives Vision and Verification.
3. Explicitly enter `Cisco` / `C9300-24T`, or `Dell` / `PowerEdge R7425`, or `HPE` / `ProLiant DL380 Gen11`, check confirmation, and rerun. Check the exact reference IDs, sections, conditions, and URLs. A different model/generation must return NO_MATCH.
4. Open another browser session: results and identity provenance synchronize from SpacetimeDB and survive reload. Existing telemetry/alerts/profile operations continue to work.

The source snapshot is client-supplied under the existing local-demo trust model. Neither provenance labels nor LLM verification authenticate a physical device or attest a hardware fault. Longer-term history, continuous physical telemetry, model-specific live management APIs, and production inventory authorization remain out of scope.
