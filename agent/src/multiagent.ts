/**
 * Multi-agent investigation: a Supervisor (Nemotron Super) delegates to Telemetry, Environment,
 * Documentation and Verification agents (each its own Nemotron call loop with its own tools)
 * over a single shared-state LangGraph.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { z } from "zod";
import { errMsg, extractJson, summarizeResult, textOf, type InvestigatorModel } from "./graph.js";
import {
  createDocumentationTool,
  createTools,
  thresholdSeverity,
  type RackDataSource,
} from "./tools.js";
import {
  FinalSynthesis,
  MultiAgentReport,
  SpecialistOutput,
  SupervisorDecision,
  VerificationOutput,
  type AgentName,
  type AgentToolCallRecord,
  type Evidence,
  type InvestigationEvent,
  type InvestigationRequest,
  type SpecialistFinding,
  type VerificationResult,
} from "./schemas.js";

export interface MultiAgentOptions {
  supervisorModel: InvestigatorModel;
  specialistModel: InvestigatorModel;
  supervisorModelName: string;
  specialistModelName: string;
  dataSource: RackDataSource;
  staleAfterMinutes: number;
  maxDelegations: number;
  maxSpecialistToolRounds: number;
  maxVerificationRetries: number;
  maxInvestigationSeconds: number;
}

export interface MultiAgentResult {
  report: MultiAgentReport;
  events: InvestigationEvent[];
}

/** Time kept in reserve for the final synthesis call. */
const FINAL_RESERVE_MS = 15_000;
const MAX_CONTEXT_CHARS = 9_000;

// ---------------------------------------------------------------- prompts

const SENSOR_RULES = `Facts about the data:
- The rover measures ONLY: AMBIENT_TEMPERATURE_C, RELATIVE_HUMIDITY_PERCENT, SOUND_RAW, ULTRASONIC_DISTANCE_CM.
  Fan RPM, CPU load, power, interface errors and hardware health are NOT available. Never invent them.
- SOUND_RAW is uncalibrated raw intensity (not decibels); alone it cannot identify a mechanical fault.
- ULTRASONIC_DISTANCE_CM alone does not prove an obstruction; ambient temperature alone does not prove a failed fan.
- Rack profile thresholds are fictional demo settings, not manufacturer specifications.
- Stale readings are not current evidence. Missing metrics are unknown, never "normal".`;

const FINDINGS_FORMAT = `When you are done, reply with ONLY this JSON object (no markdown, no prose):
{"observations": string[], "hypotheses": [{"description": string, "supporting_evidence": string[], "contradicting_evidence": string[], "missing_evidence": string[]}], "missing_information": string[], "recommended_next_action": string}
Each observation must quote the value, unit, metric, source_identifier, observed_at, and say SIMULATED or REAL.
Hypotheses are possibilities, not confirmed faults. No confidence percentages. Be concise.
Report only what YOUR tools returned for YOUR objective. Do not copy other agents' observations or hypotheses;
refer to them only to agree or disagree with specific evidence.`;

const AGENT_PROMPTS: Record<AgentName, string> = {
  telemetry: `You are the TELEMETRY AGENT of SENTINEL, a data center investigation team.
Your job: analyze current readings and history for one rack. Compare readings against the rack profile's warning and
critical thresholds, compare readings across time, detect trends and sudden changes, and list missing or stale observations.
Use your tools (get_current_telemetry, get_telemetry_history, get_rack_profile) to get the data.
Start with get_current_telemetry WITHOUT metric_type so you see every available reading and which metrics are missing;
report missing metrics explicitly. Then call only what your objective needs.
${SENSOR_RULES}
${FINDINGS_FORMAT}`,

  environment: `You are the ENVIRONMENT AGENT of SENTINEL, a data center investigation team.
Your job: assess the physical environment around the rack - ambient temperature, relative humidity, raw sound intensity
and ultrasonic distance - and the RELATIONSHIPS between them (e.g. do sound and temperature move together over time?).
Keep actual observations separate from possible environmental explanations (airflow, recirculation, nearby objects),
which are only hypotheses. You do not have threshold access; use thresholds reported by other agents if provided.
Tools: get_current_telemetry, get_telemetry_history.
${SENSOR_RULES}
${FINDINGS_FORMAT}`,

  documentation: `You are the DOCUMENTATION AGENT of SENTINEL, a data center investigation team.
Your job: retrieve the reference documentation available for this rack's equipment type with lookup_equipment_documentation,
and the configured rack profile with get_rack_profile. Report which operating limits are documented and by what source.
Clearly distinguish (a) manufacturer specifications, (b) project documentation, (c) fictional demo thresholds.
If a manufacturer specification is unavailable, say so explicitly. Cite the doc_id for every documentation claim.
Never invent manuals, specifications, model numbers or citations.
${SENSOR_RULES}
${FINDINGS_FORMAT}`,

  verification: `You are the VERIFICATION AGENT of SENTINEL, an independent reviewer.
You receive findings written by other agents. Do NOT restate them; judge them.
- Spot-check the key factual claims against the data yourself with get_current_telemetry / get_telemetry_history.
- Flag claims not supported by tool data, root-cause claims stated as fact, and contradictions between agents or with the data.
- List evidence that is missing for the conclusions drawn.
- Only list a claim in verified_findings if the tool data supports it.
- Set request_more_investigation to true only if a specific specialist could close an important gap with the data
  that exists (telemetry, environment, or documentation); then name it in follow_up_agent with a follow_up_objective.
${SENSOR_RULES}
When done, reply with ONLY this JSON object:
{"grounded": boolean, "verified_findings": string[], "unsupported_claims": string[], "contradictions": string[], "missing_evidence": string[], "request_more_investigation": boolean, "follow_up_agent": "telemetry"|"environment"|"documentation"|null, "follow_up_objective": string|null}`,
};

const SUPERVISOR_PROMPT = `You are the SUPERVISOR of SENTINEL, a team of AI agents investigating one data center rack.
You do not call tools. You plan, delegate one task at a time, read the findings, and decide what to do next.

Your team:
- telemetry: threshold violations, trends and sudden changes, missing/stale readings (tools: current telemetry, history, rack profile)
- environment: relationships between temperature, humidity, raw sound and ultrasonic distance (tools: current telemetry, history)
- documentation: available equipment reference docs vs. fictional demo thresholds; whether manufacturer specs exist (tools: doc lookup, rack profile)
- verification: independent check of the other agents' findings against the data; may request a follow-up

Routing rules:
- Delegate only what the evidence calls for. Do not call every agent by default.
- A rack whose data looks routine needs a minimal investigation (usually one telemetry check), then finish.
- Abnormal readings, alerts, contradictions or stale/missing data justify more specialists, then verification before finishing.
- Never repeat the same objective for the same agent. If verification asked for a follow-up, decide whether it is worth it.
- Finish when more delegation would not change the conclusion, or when the budget is nearly used.

Reply with ONLY this JSON object:
{"plan": string (REQUIRED on your first decision: 1-3 sentences; omit later), "next": "telemetry"|"environment"|"documentation"|"verification"|"finish", "objective": string (the specific task for that agent; empty when finishing), "reason": string (one short sentence)}`;

const FINAL_PROMPT = `Write the final diagnostic report from the team's findings above.
Reply with ONLY this JSON object:
{"severity": "NORMAL"|"WARNING"|"CRITICAL"|"UNKNOWN", "summary": string, "hypotheses": [{"description": string, "supporting_evidence": string[], "contradicting_evidence": string[], "missing_evidence": string[]}], "recommended_next_inspection": string[], "verified_findings": string[], "missing_information": string[]}
Rules:
- summary: measured facts (values, units, timestamps) and configured thresholds, clearly labelled; note simulated provenance.
- hypotheses: competing explanations drawn from the specialists, with evidence for and against. Not confirmed faults.
- verified_findings: only claims the Verification Agent confirmed (empty if verification did not run).
- Drop, or explicitly qualify as unsupported, any claim the Verification Agent listed in unsupported_claims.
- missing_information: unavailable or stale evidence, and missing manufacturer specs if documentation says so.
- Do not claim a confirmed hardware failure or root cause. No confidence percentages. No invented specs.`;

// ---------------------------------------------------------------- helpers

function clip(s: string, n = MAX_CONTEXT_CHARS): string {
  return s.length <= n ? s : `${s.slice(0, n)}...[truncated]`;
}

function dataInventory(req: InvestigationRequest, staleAfterMinutes: number) {
  const asOf = new Date(req.as_of ?? Date.now()).getTime();
  const metrics = new Set([...req.current_telemetry, ...req.recent_telemetry].map((r) => r.metric_type));
  return [...metrics].map((m) => {
    const cur = req.current_telemetry.filter((r) => r.metric_type === m);
    return {
      metric_type: m,
      current_readings: cur.length,
      stale_current_readings: cur.filter((r) => (asOf - Date.parse(r.observed_at)) / 60000 > staleAfterMinutes).length,
      history_points: req.recent_telemetry.filter((r) => r.metric_type === m).length,
    };
  });
}

function findingsDigest(findings: SpecialistFinding[], verification: VerificationResult | null) {
  return clip(
    JSON.stringify({
      specialist_findings: findings.map((f) => ({
        agent: f.agent,
        objective: f.objective,
        status: f.status,
        observations: f.observations,
        hypotheses: f.hypotheses,
        missing_information: f.missing_information,
        recommended_next_action: f.recommended_next_action,
        tools: f.tools_executed.map((t) => `${t.tool} -> ${t.result_summary}`),
      })),
      verification: verification && {
        grounded: verification.grounded,
        verified_findings: verification.verified_findings,
        unsupported_claims: verification.unsupported_claims,
        contradictions: verification.contradictions,
        missing_evidence: verification.missing_evidence,
        request_more_investigation: verification.request_more_investigation,
        follow_up_agent: verification.follow_up_agent,
        follow_up_objective: verification.follow_up_objective,
      },
    }),
  );
}

export function createAgentToolsets(ds: RackDataSource): Record<AgentName, StructuredToolInterface[]> {
  const [current, history, profile] = createTools(ds);
  const docs = createDocumentationTool();
  return {
    telemetry: [current, history, profile],
    environment: [current, history],
    documentation: [docs, profile],
    verification: [current, history],
  };
}

// ---------------------------------------------------------------- graph state

type Assignment = { agent: AgentName; objective: string; status: SpecialistFinding["status"] };

const keep = <T>(fallback: () => T) => Annotation<T>({ reducer: (_a, b) => b, default: fallback });

const State = Annotation.Root({
  request: keep<InvestigationRequest | null>(() => null),
  plan: keep<string>(() => ""),
  decision: keep<SupervisorDecision | null>(() => null),
  assignments: keep<Assignment[]>(() => []),
  findings: keep<SpecialistFinding[]>(() => []),
  verificationResult: keep<VerificationResult | null>(() => null),
  verificationRuns: keep<number>(() => 0),
  delegations: keep<number>(() => 0),
  limitsReached: keep<string[]>(() => []),
  fatalError: keep<string | null>(() => null),
});
type S = typeof State.State;

// ---------------------------------------------------------------- engine

export async function runMultiAgentInvestigation(
  request: InvestigationRequest,
  opts: MultiAgentOptions,
): Promise<MultiAgentResult> {
  const started = Date.now();
  const deadline = started + opts.maxInvestigationSeconds * 1000;
  const remaining = () => deadline - Date.now();

  // Per-request collectors (never shared between investigations).
  const events: InvestigationEvent[] = [];
  const toolCalls: AgentToolCallRecord[] = [];
  const evidence: Evidence = { measurements: [], history: [], configured_thresholds: null, documentation: [] };
  const seen = new Set<string>();
  const emit = (
    type: InvestigationEvent["type"],
    description: string,
    status: InvestigationEvent["status"] = "INFO",
    extra: { agent?: string; tool?: string } = {},
  ) => events.push({ type, timestamp: new Date().toISOString(), description, status, ...extra });

  const toolsets = createAgentToolsets(opts.dataSource);
  const policySeverity = thresholdSeverity(request, opts.staleAfterMinutes);
  const rackHeader = `Rack "${request.rack_id}" (${request.rack_name}), equipment type: ${request.equipment_type}. Reference time (as_of): ${request.as_of ?? new Date(started).toISOString()}.`;

  /** Record actual tool output as evidence (code-compiled, not model-written). */
  function collectEvidence(raw: string) {
    let r: any;
    try {
      r = JSON.parse(raw);
    } catch {
      return;
    }
    if (r?.error) return;
    for (const m of r.readings ?? []) {
      const k = `m|${m.metric_type}|${m.source_identifier}|${m.observed_at}`;
      if (!seen.has(k)) seen.add(k) && evidence.measurements.push(m);
    }
    if (r.available === true && Array.isArray(r.observations)) {
      const k = `h|${r.metric_type}|${r.returned}`;
      if (!seen.has(k)) {
        seen.add(k);
        evidence.history.push({
          metric_type: r.metric_type,
          observations: r.returned,
          order: r.order,
          from: r.observations[0]?.observed_at,
          to: r.observations.at(-1)?.observed_at,
          stats: r.stats,
          source_identifiers: [...new Set(r.observations.map((o: any) => o.source_identifier))],
          simulated: r.observations.every((o: any) => o.simulated),
        });
      }
    }
    if (r.profile) {
      evidence.configured_thresholds = { ...r.profile, provenance: "FICTIONAL_DEMO_CONFIGURATION" };
    }
    for (const d of r.documents ?? []) {
      const k = `d|${d.doc_id}`;
      if (!seen.has(k)) {
        seen.add(k);
        evidence.documentation.push({
          doc_id: d.doc_id,
          title: d.title,
          source_type: d.source_type,
          verified: d.verified,
          availability: d.availability ?? "AVAILABLE",
        });
      }
    }
  }

  /** One agent's own Nemotron tool loop, returning schema-validated JSON. */
  async function runAgent<T extends z.ZodTypeAny>(
    agent: AgentName,
    userContent: string,
    schema: T,
  ): Promise<{ output: z.infer<T> | null; records: AgentToolCallRecord[]; status: SpecialistFinding["status"]; problem?: string }> {
    const allowed = toolsets[agent];
    const byName = new Map(allowed.map((t) => [t.name, t]));
    const bound = opts.specialistModel.bindTools(allowed);
    const msgs: BaseMessage[] = [new SystemMessage(AGENT_PROMPTS[agent]), new HumanMessage(userContent)];
    const records: AgentToolCallRecord[] = [];
    let rounds = 0;
    let status: SpecialistFinding["status"] = "COMPLETED";
    let text = "";

    try {
      while (true) {
        let resp = await bound.invoke(msgs, { timeout: Math.max(1000, remaining()) });
        let calls = resp.tool_calls ?? [];
        if ((resp.invalid_tool_calls?.length ?? 0) > 0 && calls.length === 0 && rounds < opts.maxSpecialistToolRounds) {
          emit("AGENT", `${agent} produced a malformed tool call; asking it to retry`, "ERROR", { agent });
          rounds++;
          msgs.push(new AIMessage(textOf(resp) || "(malformed tool call)"), new HumanMessage("Your tool call was malformed. Retry with valid arguments or give your findings JSON."));
          continue;
        }
        if (calls.length === 0) {
          text = textOf(resp);
          break;
        }
        if (rounds >= opts.maxSpecialistToolRounds || remaining() < FINAL_RESERVE_MS) {
          status = "INCOMPLETE";
          emit("GUARD", `${agent} reached its tool-round or time limit; requesting findings now`, "INFO", { agent });
          resp = await opts.specialistModel.invoke(
            [...msgs, new HumanMessage("Your tool budget is used up. Reply now with ONLY the JSON object from your instructions.")],
            { timeout: Math.max(1000, remaining()) },
          );
          text = textOf(resp);
          break;
        }
        rounds++;
        msgs.push(new AIMessage({ content: resp.content, tool_calls: calls }));
        for (const call of calls) {
          const t = byName.get(call.name);
          let raw: string;
          if (!t) {
            raw = JSON.stringify({ error: `Tool "${call.name}" is not available to the ${agent} agent` });
          } else {
            try {
              raw = String(await t.invoke(call.args));
            } catch (err) {
              raw = JSON.stringify({ error: `Invalid arguments for ${call.name}: ${errMsg(err)}` });
            }
          }
          const { status: st, summary } = summarizeResult(raw);
          const rec = { agent, round: rounds, tool: call.name, args: call.args, status: st, result_summary: summary };
          records.push(rec);
          toolCalls.push(rec);
          if (st === "SUCCESS") collectEvidence(raw);
          emit("TOOL", `[${agent}] ${call.name} ${st === "SUCCESS" ? "returned" : "failed"}: ${summary}`, st, { agent, tool: call.name });
          msgs.push(new ToolMessage({ content: raw, tool_call_id: call.id ?? `${agent}_${rounds}_${records.length}`, name: call.name }));
        }
      }

      // Parse + one bounded repair.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return { output: schema.parse(extractJson(text)), records, status };
        } catch (err) {
          if (attempt === 1) throw err;
          emit("AGENT", `${agent} returned malformed findings (${errMsg(err).slice(0, 120)}); requesting one repair`, "ERROR", { agent });
          const fix = await opts.specialistModel.invoke(
            [...msgs, new AIMessage(text.slice(0, 4000) || "(empty)"), new HumanMessage(`Invalid output (${errMsg(err).slice(0, 300)}). Reply with ONLY the corrected JSON object.`)],
            { timeout: Math.max(1000, remaining()) },
          );
          text = textOf(fix);
        }
      }
    } catch (err) {
      const problem = errMsg(err);
      const isParse = /JSON|invalid|expected|Required/i.test(problem) && !/\b(4\d\d|5\d\d)\b/.test(problem);
      emit("ERROR", `${agent} agent ${isParse ? "output invalid" : "model call failed"}: ${problem.slice(0, 200)}`, "ERROR", { agent });
      return { output: null, records, status: isParse ? "INCOMPLETE" : "FAILED", problem };
    }
    return { output: null, records, status: "INCOMPLETE" };
  }

  // ---- Supervisor: plan, delegate, review, decide ----
  async function supervisor(state: S): Promise<Partial<S>> {
    const limits = [...state.limitsReached];
    const finish = (reason: string, limit?: string): Partial<S> => {
      if (limit && !limits.includes(limit)) limits.push(limit);
      emit(limit ? "GUARD" : "SUPERVISOR", reason, "INFO", { agent: "supervisor" });
      return { decision: { plan: undefined, next: "finish", objective: "", reason }, limitsReached: limits };
    };

    if (remaining() < FINAL_RESERVE_MS) {
      return finish(`Time budget (${opts.maxInvestigationSeconds}s) nearly used; finishing`, "MAX_INVESTIGATION_SECONDS");
    }

    const context = `${rackHeader}
Active alerts: ${request.active_alerts.length ? request.active_alerts.map((a) => `[${a.severity}] ${a.message}`).join("; ") : "none"}
Data inventory (counts only): ${JSON.stringify(dataInventory(request, opts.staleAfterMinutes))}
Budget: ${state.delegations}/${opts.maxDelegations} delegations used; verification runs ${state.verificationRuns}/${opts.maxVerificationRetries + 1}; ~${Math.round(remaining() / 1000)}s left.
Your plan so far: ${state.plan || "(none yet - include a plan)"}
Delegations so far: ${state.assignments.length ? state.assignments.map((a) => `${a.agent}: ${a.objective} [${a.status}]`).join(" | ") : "none"}
Team findings so far: ${state.findings.length || state.verificationResult ? findingsDigest(state.findings, state.verificationResult) : "none"}
Decide the next step.`;

    const msgs: BaseMessage[] = [new SystemMessage(SUPERVISOR_PROMPT), new HumanMessage(context)];
    let decision: SupervisorDecision | null = null;
    for (let attempt = 0; attempt < 2 && !decision; attempt++) {
      let text: string;
      try {
        text = textOf(await opts.supervisorModel.invoke(msgs, { timeout: Math.max(1000, remaining() - FINAL_RESERVE_MS) }));
      } catch (err) {
        emit("ERROR", `Supervisor model call failed: ${errMsg(err)}`, "ERROR", { agent: "supervisor" });
        return { fatalError: errMsg(err) };
      }
      try {
        decision = SupervisorDecision.parse(extractJson(text));
      } catch (err) {
        emit("SUPERVISOR", `Supervisor returned an invalid decision (${errMsg(err).slice(0, 120)}); requesting one repair`, "ERROR", { agent: "supervisor" });
        msgs.push(new AIMessage(text.slice(0, 2000) || "(empty)"), new HumanMessage(`Invalid decision (${errMsg(err).slice(0, 300)}). Reply with ONLY the JSON object.`));
      }
    }
    if (!decision) return finish("Supervisor could not produce a valid decision; finishing", "SUPERVISOR_OUTPUT_INVALID");

    const update: Partial<S> = {};
    if (!state.plan && decision.plan) {
      update.plan = decision.plan;
      emit("SUPERVISOR", `Plan: ${decision.plan}`, "INFO", { agent: "supervisor" });
    }

    // Guards: enforce limits and minimum diligence, always visibly.
    let { next } = decision;
    let objective = decision.objective;
    if (next !== "finish" && state.delegations >= opts.maxDelegations) {
      return { ...update, ...finish(`Supervisor wanted ${next} but the ${opts.maxDelegations}-delegation limit is reached`, "MAX_DELEGATIONS") };
    }
    if (next === "verification" && state.verificationRuns > opts.maxVerificationRetries) {
      return { ...update, ...finish("Verification retry limit reached; finishing", "MAX_VERIFICATION_RETRIES") };
    }
    if (next === "finish" && state.findings.length === 0 && state.delegations < opts.maxDelegations) {
      next = "telemetry";
      objective = "Check current readings and their freshness against the rack profile thresholds.";
      emit("GUARD", "Supervisor tried to finish with no evidence; at least one specialist must examine the data", "INFO", { agent: "supervisor" });
    } else if (next === "finish" && policySeverity !== "NORMAL" && state.verificationRuns === 0 && state.delegations < opts.maxDelegations) {
      next = "verification";
      objective = "Independently check the specialist findings against the data before the report is written.";
      emit("GUARD", `Rack is not clearly normal (${policySeverity}); verification required before finishing`, "INFO", { agent: "supervisor" });
    }

    if (next === "finish") {
      emit("SUPERVISOR", `Decided to finish: ${decision.reason}`, "INFO", { agent: "supervisor" });
    } else {
      emit("SUPERVISOR", `Delegated to ${next}: ${objective}${decision.reason ? ` (reason: ${decision.reason})` : ""}`, "INFO", { agent: "supervisor" });
    }
    return { ...update, decision: { ...decision, next, objective } };
  }

  // ---- Specialists ----
  const specialistNode = (agent: Exclude<AgentName, "verification">) => async (state: S): Promise<Partial<S>> => {
    const objective = state.decision?.objective || `Investigate rack ${request.rack_id}`;
    emit("AGENT", `${agent} agent started: ${objective}`, "INFO", { agent });
    const prior = state.findings.length ? `\nFindings from other agents (use as context, verify with your tools):\n${findingsDigest(state.findings, null)}` : "";
    const res = await runAgent(agent, `${rackHeader}\nYour objective from the Supervisor: ${objective}${prior}`, SpecialistOutput);
    const finding: SpecialistFinding = {
      agent,
      objective,
      observations: res.output?.observations ?? [],
      hypotheses: res.output?.hypotheses ?? [],
      missing_information: res.output?.missing_information ?? (res.problem ? [`${agent} agent produced no valid findings`] : []),
      recommended_next_action: res.output?.recommended_next_action ?? "",
      tools_executed: res.records,
      status: res.output ? res.status : res.status === "COMPLETED" ? "INCOMPLETE" : res.status,
    };
    emit("AGENT", `${agent} agent ${finding.status.toLowerCase()}: ${finding.observations.length} observation(s), ${finding.hypotheses.length} hypothesis(es), ${res.records.length} tool call(s)`, finding.status === "COMPLETED" ? "SUCCESS" : "ERROR", { agent });
    return {
      findings: [...state.findings, finding],
      assignments: [...state.assignments, { agent, objective, status: finding.status }],
      delegations: state.delegations + 1,
    };
  };

  // ---- Verification ----
  async function verificationNode(state: S): Promise<Partial<S>> {
    const objective = state.decision?.objective || "Verify the specialist findings.";
    emit("AGENT", `verification agent started: ${objective}`, "INFO", { agent: "verification" });
    const res = await runAgent(
      "verification",
      `${rackHeader}\nObjective: ${objective}\nFindings to review:\n${findingsDigest(state.findings, null)}`,
      VerificationOutput,
    );
    const v: VerificationResult = {
      grounded: res.output?.grounded ?? false,
      verified_findings: res.output?.verified_findings ?? [],
      unsupported_claims: res.output?.unsupported_claims ?? [],
      contradictions: res.output?.contradictions ?? [],
      missing_evidence: res.output?.missing_evidence ?? (res.output ? [] : ["Verification agent produced no valid result"]),
      request_more_investigation: res.output?.request_more_investigation ?? false,
      follow_up_agent: res.output?.follow_up_agent ?? null,
      follow_up_objective: res.output?.follow_up_objective ?? null,
      tools_executed: res.records,
      status: res.output ? res.status : res.status === "COMPLETED" ? "INCOMPLETE" : res.status,
    };
    emit(
      "VERIFY",
      `Verification ${v.grounded ? "found the findings grounded" : "found grounding problems"}: ${v.verified_findings.length} verified, ${v.unsupported_claims.length} unsupported, ${v.contradictions.length} contradiction(s)` +
        (v.request_more_investigation ? `; requested follow-up by ${v.follow_up_agent ?? "a specialist"}: ${v.follow_up_objective ?? ""}` : ""),
      v.status === "COMPLETED" ? "SUCCESS" : "ERROR",
      { agent: "verification" },
    );
    return {
      verificationResult: v,
      verificationRuns: state.verificationRuns + 1,
      assignments: [...state.assignments, { agent: "verification", objective, status: v.status }],
      delegations: state.delegations + 1,
    };
  }

  // ---- Final synthesis by the Supervisor ----
  let report: MultiAgentReport | null = null;
  async function finalNode(state: S): Promise<Partial<S>> {
    const modelLabel =
      opts.supervisorModelName === opts.specialistModelName
        ? opts.supervisorModelName
        : `${opts.supervisorModelName} (supervisor), ${opts.specialistModelName} (specialists)`;
    const base = {
      rack_id: request.rack_id,
      tool_calls: toolCalls,
      model: modelLabel,
      generated_at: new Date().toISOString(),
      supervisor_plan: state.plan,
      agents_invoked: state.assignments,
      specialist_findings: state.findings,
      verification: state.verificationResult,
      evidence,
      limits_reached: state.limitsReached,
    };
    const failed = (summary: string, status: "FAILED" | "INCOMPLETE"): MultiAgentReport => ({
      ...base,
      severity: "UNKNOWN",
      summary,
      hypotheses: [],
      recommended_next_inspection: ["Review the specialist findings and evidence, then retry the investigation."],
      verified_findings: state.verificationResult?.verified_findings ?? [],
      missing_information: [],
      investigation_status: status,
    });

    if (state.fatalError) {
      report = failed(`Investigation failed: the Supervisor model call did not succeed (${state.fatalError}). No diagnosis was produced.`, "FAILED");
      emit("REPORT", "No report generated because the investigation failed", "ERROR");
      return {};
    }

    const msgs: BaseMessage[] = [
      new SystemMessage(SUPERVISOR_PROMPT),
      new HumanMessage(
        `${rackHeader}\nPlan: ${state.plan}\nTeam findings:\n${findingsDigest(state.findings, state.verificationResult)}\n\n${FINAL_PROMPT}\nThe threshold policy applied to fresh readings gives severity ${policySeverity}; the report's severity will be ${policySeverity}, so write the summary consistently with it.`,
      ),
    ];
    let lastProblem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        text = textOf(await opts.supervisorModel.invoke(msgs, { timeout: Math.max(5000, remaining()) }));
      } catch (err) {
        emit("ERROR", `Supervisor synthesis call failed: ${errMsg(err)}`, "ERROR", { agent: "supervisor" });
        report = failed(`Investigation failed while synthesizing the final report (${errMsg(err)}).`, "FAILED");
        return {};
      }
      try {
        const syn = FinalSynthesis.parse(extractJson(text));
        if (syn.severity !== policySeverity) {
          emit("GUARD", `Severity adjusted from ${syn.severity} to ${policySeverity} per configured profile thresholds on fresh readings`);
          syn.severity = policySeverity;
        }
        const status = state.limitsReached.length ? "INCOMPLETE" : "COMPLETED";
        report = MultiAgentReport.parse({ ...base, ...syn, investigation_status: status });
        emit("REPORT", `Supervisor synthesized the final report (severity ${syn.severity}, status ${status})`, "SUCCESS", { agent: "supervisor" });
        return {};
      } catch (err) {
        lastProblem = errMsg(err);
        emit("REPORT", `Final report output was malformed: ${lastProblem.slice(0, 160)}`, "ERROR", { agent: "supervisor" });
        msgs.push(new AIMessage(text.slice(0, 4000) || "(empty)"), new HumanMessage(`Invalid (${lastProblem.slice(0, 300)}). Reply with ONLY the corrected JSON object.`));
      }
    }
    report = failed(`The Supervisor did not return a valid final report after one repair (${lastProblem.slice(0, 200)}). Specialist findings and evidence are included; no diagnosis is asserted.`, "INCOMPLETE");
    return {};
  }

  const route = (state: S) => (state.fatalError || !state.decision || state.decision.next === "finish" ? "final" : state.decision.next);

  const graph = new StateGraph(State)
    .addNode("supervisor", supervisor)
    .addNode("telemetry", specialistNode("telemetry"))
    .addNode("environment", specialistNode("environment"))
    .addNode("documentation", specialistNode("documentation"))
    .addNode("verification", verificationNode)
    .addNode("final", finalNode)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", route, ["telemetry", "environment", "documentation", "verification", "final"])
    .addEdge("telemetry", "supervisor")
    .addEdge("environment", "supervisor")
    .addEdge("documentation", "supervisor")
    .addEdge("verification", "supervisor")
    .addEdge("final", END)
    .compile();

  emit("START", `Multi-agent investigation started for ${request.rack_name} (${request.rack_id})`);
  try {
    await graph.invoke({ request }, { recursionLimit: opts.maxDelegations * 2 + 10 });
  } catch (err) {
    emit("ERROR", `Graph execution failed: ${errMsg(err)}`, "ERROR");
  }
  const final: MultiAgentReport =
    report ?? {
      rack_id: request.rack_id,
      severity: "UNKNOWN",
      summary: "Investigation failed before a report could be produced.",
      hypotheses: [],
      recommended_next_inspection: ["Retry the investigation."],
      tool_calls: toolCalls,
      investigation_status: "FAILED",
      model: opts.supervisorModelName,
      generated_at: new Date().toISOString(),
      supervisor_plan: "",
      agents_invoked: [],
      specialist_findings: [],
      verification: null,
      verified_findings: [],
      missing_information: [],
      evidence,
      limits_reached: [],
    };
  emit("END", `Investigation ${final.investigation_status.toLowerCase()} in ${((Date.now() - started) / 1000).toFixed(1)}s`, final.investigation_status === "FAILED" ? "ERROR" : "SUCCESS");
  return { report: final, events };
}
