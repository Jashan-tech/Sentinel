import { jsonrepair } from "jsonrepair";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Runnable } from "@langchain/core/runnables";
import { thresholdSeverity } from "./tools.js";
import {
  DiagnosticReport,
  ModelReport,
  type InvestigationEvent,
  type InvestigationRequest,
  type ToolCallRecord,
} from "./schemas.js";

/** Minimal model surface the graph needs (satisfied by ChatOpenAI and by test fakes). */
export interface InvestigatorModel {
  bindTools(tools: StructuredToolInterface[]): Runnable<BaseMessage[], AIMessage>;
  invoke(messages: BaseMessage[], config?: { timeout?: number; signal?: AbortSignal }): Promise<AIMessage>;
}

export interface InvestigationOptions {
  model: InvestigatorModel;
  modelName: string;
  tools: StructuredToolInterface[];
  maxRounds: number;
  staleAfterMinutes: number;
}

export interface InvestigationResult {
  report: DiagnosticReport;
  events: InvestigationEvent[];
}

const SYSTEM_PROMPT = `You are SENTINEL, an autonomous data center investigation agent.
You investigate one rack using read-only tools, then a separate step writes the report.

Available evidence comes ONLY from tool results. The rover can measure exactly:
AMBIENT_TEMPERATURE_C, RELATIVE_HUMIDITY_PERCENT, SOUND_RAW.
Ultrasonic distance is exclusively collision safety, never equipment diagnosis or missing equipment evidence.
Fan RPM, CPU load, power, switch errors and hardware health are NOT available.

How to investigate:
- Decide which evidence would most change your assessment and call the tool for it.
- Look up the rack profile before judging any reading; thresholds differ per profile and are fictional demo settings unless the profile says they come from a manufacturer-documented range.
- When a reading is near or over a threshold, check its history to see if it is rising, stable or falling.
- Treat stale readings as not current. Treat missing metrics as unknown, never as normal.
- Stop calling tools when more evidence would not change your conclusion.

Rules: never invent readings or manufacturer specifications. Ambient temperature alone does not prove a failed fan;
SOUND_RAW is uncalibrated and alone does not identify a mechanical fault. Keep any text you write brief.`;

const REPORT_PROMPT = `Investigation finished. Write the diagnostic report as a single JSON object and nothing else
(no markdown fences, no commentary). Schema:
{
  "severity": "NORMAL" | "WARNING" | "CRITICAL" | "UNKNOWN",
  "summary": string,
  "hypotheses": [{ "description": string, "supporting_evidence": string[], "contradicting_evidence": string[], "missing_evidence": string[] }],
  "recommended_next_inspection": string[]
}
Requirements:
- Base every statement on tool results above; quote actual values, units and thresholds.
- Hypotheses are possible explanations, not confirmed faults. Do not claim a root cause.
- No confidence percentages. No manufacturer specs.
- Severity follows the rack profile thresholds applied to FRESH (non-stale) readings:
  CRITICAL if any fresh reading is at/above its critical threshold; otherwise WARNING if any is at/above its warning threshold;
  otherwise NORMAL if fresh ambient temperature is available and in range; UNKNOWN if there is no fresh ambient temperature.
  A rising trend below the warning threshold does not raise severity; mention it in the summary and hypotheses instead.
- Every supporting_evidence item must be an observation that actually points toward that hypothesis. A metric having a value
  is not support by itself: SOUND_RAW without a change over time,
  does not support a fault. Omit hypotheses that have no real supporting evidence.
- If key evidence is missing or stale, say so in missing_evidence. Never call a rack NORMAL without fresh in-range readings.
- Only describe inspections that tools actually performed; put physical checks in recommended_next_inspection.`;

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  rounds: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  malformedRetries: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  budgetExhausted: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  fatalError: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
});
type S = typeof State.State;

export function textOf(msg: BaseMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  return c
    .map((p) => (typeof p === "string" ? p : "text" in p && typeof p.text === "string" ? p.text : ""))
    .join("");
}

/** Pull the first {...} JSON object out of model text (tolerates fences and preambles). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in model output");
  const end = cleaned.lastIndexOf("}");
  const body = end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
  try {
    return JSON.parse(body);
  } catch (err) {
    // Two objects back to back ("{...}{...}" or "{...}\n{...}"): use the first complete one.
    const first = firstBalancedObject(cleaned, start);
    if (first) {
      try {
        return JSON.parse(first);
      } catch {
        // fall through to local repair
      }
    }
    // Common model slips (a missing comma, a trailing comma, an unescaped quote, a cut-off tail) are
    // repaired locally instead of costing another 10-20 s model round trip. The repaired object still
    // goes through the same strict schema validation, so nothing unvalidated gets through.
    try {
      return JSON.parse(jsonrepair(cleaned.slice(start)));
    } catch {
      throw err;
    }
  }
}

/** The first brace-balanced {...} starting at `start`, respecting strings; null if unbalanced. */
function firstBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***").slice(0, 300);
}

function fmtArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

export function summarizeResult(raw: string): { status: "SUCCESS" | "ERROR"; summary: string } {
  try {
    const r = JSON.parse(raw);
    if (r.error) return { status: "ERROR", summary: String(r.error) };
    if (Array.isArray(r.readings)) {
      const staleCount = r.readings.filter((x: { stale: boolean }) => x.stale).length;
      return {
        status: "SUCCESS",
        summary: `${r.readings.length} reading(s), ${staleCount} stale; missing: ${r.missing_metrics.join(", ") || "none"}`,
      };
    }
    if ("available" in r) {
      return {
        status: "SUCCESS",
        summary: r.available
          ? `${r.returned} ${r.metric_type} observation(s), ${r.stats.first} -> ${r.stats.last}`
          : `no ${r.metric_type} history available`,
      };
    }
    if (Array.isArray(r.documents)) {
      return {
        status: "SUCCESS",
        summary: `${r.documents.length} document(s) for ${r.equipment_type}; manufacturer spec available: ${r.manufacturer_specification_available}`,
      };
    }
    if (r.profile) {
      return {
        status: "SUCCESS",
        summary: `profile "${r.profile.name}" (temp warn ${r.profile.temperature_warning_c} C / crit ${r.profile.temperature_critical_c} C)`,
      };
    }
  } catch {
    /* fall through */
  }
  return { status: "SUCCESS", summary: raw.slice(0, 120) };
}

export async function runInvestigation(
  request: InvestigationRequest,
  opts: InvestigationOptions,
): Promise<InvestigationResult> {
  // Per-request collectors: nothing here is shared between investigations.
  const events: InvestigationEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const emit = (
    type: InvestigationEvent["type"],
    description: string,
    status: InvestigationEvent["status"] = "INFO",
    tool?: string,
  ) => events.push({ type, timestamp: new Date().toISOString(), description, status, tool });

  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  const boundModel = opts.model.bindTools(opts.tools);
  let report: DiagnosticReport | null = null;

  const baseReport = (status: DiagnosticReport["investigation_status"]) => ({
    rack_id: request.rack_id,
    tool_calls: toolCalls,
    investigation_status: status,
    model: opts.modelName,
    generated_at: new Date().toISOString(),
  });

  // ---- Node: Nemotron reviews evidence and decides on the next tool(s) ----
  async function investigate(state: S): Promise<Partial<S>> {
    let response: AIMessage;
    try {
      response = await boundModel.invoke(state.messages);
    } catch (err) {
      emit("ERROR", `Nemotron call failed: ${errMsg(err)}`, "ERROR");
      return { fatalError: errMsg(err) };
    }
    const calls = response.tool_calls ?? [];
    const invalid = response.invalid_tool_calls ?? [];

    if (invalid.length > 0) {
      emit("MODEL", `Nemotron produced ${invalid.length} malformed tool call(s)`, "ERROR");
      if (calls.length === 0) {
        // Drop the malformed message and ask once for a corrected call.
        const retry = state.malformedRetries + 1;
        return {
          malformedRetries: retry,
          messages: [
            new AIMessage({ content: textOf(response) || "(malformed tool call)" }),
            new HumanMessage(
              retry <= 1
                ? "Your previous tool call had invalid arguments. Retry with valid JSON arguments, or stop if you have enough evidence."
                : "Tool calls are still malformed; stop investigating.",
            ),
          ],
        };
      }
      // Keep only the valid calls.
      response = new AIMessage({ content: response.content, tool_calls: calls });
    }

    if (calls.length > 0) {
      if (state.rounds >= opts.maxRounds) {
        emit("MODEL", `Nemotron requested more tools but the ${opts.maxRounds}-round budget is exhausted`);
        return { budgetExhausted: true }; // do not append the unanswered tool calls
      }
      for (const c of calls) emit("MODEL", `Nemotron requested ${c.name}(${fmtArgs(c.args)})`, "INFO", c.name);
    } else {
      emit("MODEL", "Nemotron concluded it has enough evidence");
    }
    return { messages: [response] };
  }

  // ---- Node: execute the tools Nemotron selected ----
  async function executeTools(state: S): Promise<Partial<S>> {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    const round = state.rounds + 1;
    const out: ToolMessage[] = [];
    for (const call of last.tool_calls ?? []) {
      const id = call.id ?? `call_${round}_${out.length}`;
      const t = toolsByName.get(call.name);
      let raw: string;
      if (!t) {
        raw = JSON.stringify({ error: `Unknown tool "${call.name}"` });
      } else {
        try {
          raw = String(await t.invoke(call.args));
        } catch (err) {
          // Zod argument validation failures land here.
          raw = JSON.stringify({ error: `Invalid arguments for ${call.name}: ${errMsg(err)}` });
        }
      }
      const { status, summary } = summarizeResult(raw);
      toolCalls.push({ round, tool: call.name, args: call.args, status, result_summary: summary });
      emit("TOOL", `${call.name} ${status === "SUCCESS" ? "returned" : "failed"}: ${summary}`, status, call.name);
      out.push(new ToolMessage({ content: raw, tool_call_id: id, name: call.name }));
    }
    return { messages: out, rounds: round };
  }

  // ---- Node: produce the validated structured report ----
  async function writeReport(state: S): Promise<Partial<S>> {
    if (state.fatalError) {
      report = {
        ...baseReport("FAILED"),
        severity: "UNKNOWN",
        summary: `Investigation failed: the Nemotron model call did not succeed (${state.fatalError}). No diagnosis was produced.`,
        hypotheses: [],
        recommended_next_inspection: ["Retry the investigation once the model API is reachable."],
      };
      emit("REPORT", "No report generated because the investigation failed", "ERROR");
      return {};
    }

    const policy = thresholdSeverity(request, opts.staleAfterMinutes);
    const convo: BaseMessage[] = [
      ...state.messages,
      new HumanMessage(
        `${REPORT_PROMPT}\nThe threshold policy applied to fresh readings gives severity ${policy}; the report's severity will be ${policy}, so write the summary consistently with it.`,
      ),
    ];
    let lastProblem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        text = textOf(await opts.model.invoke(convo));
      } catch (err) {
        emit("ERROR", `Nemotron report call failed: ${errMsg(err)}`, "ERROR");
        report = {
          ...baseReport("FAILED"),
          severity: "UNKNOWN",
          summary: `Investigation failed while generating the report (${errMsg(err)}).`,
          hypotheses: [],
          recommended_next_inspection: ["Retry the investigation."],
        };
        return {};
      }
      try {
        const parsed = ModelReport.parse(extractJson(text));
        if (parsed.severity !== policy) {
          emit("REPORT", `Severity adjusted from ${parsed.severity} to ${policy} per configured profile thresholds on fresh readings`);
          parsed.severity = policy;
        }
        const status = state.budgetExhausted ? "INCOMPLETE" : "COMPLETED";
        report = DiagnosticReport.parse({ ...parsed, ...baseReport(status) });
        emit(
          "REPORT",
          `Diagnostic report generated (severity ${parsed.severity}${attempt ? ", after one repair" : ""})`,
          "SUCCESS",
        );
        return {};
      } catch (err) {
        lastProblem = errMsg(err);
        emit("REPORT", `Report output was malformed: ${lastProblem.slice(0, 160)}`, "ERROR");
        convo.push(
          new AIMessage(text.slice(0, 4000)),
          new HumanMessage(
            `That was not valid. Problem: ${lastProblem}. Return ONLY the corrected JSON object matching the schema.`,
          ),
        );
      }
    }
    report = {
      ...baseReport("INCOMPLETE"),
      severity: "UNKNOWN",
      summary: `Nemotron did not return a valid structured report after one repair attempt (${lastProblem.slice(0, 200)}). Tool evidence collected is listed in tool_calls; no diagnosis is asserted.`,
      hypotheses: [],
      recommended_next_inspection: ["Review the collected tool evidence manually or retry the investigation."],
    };
    return {};
  }

  const routeAfterInvestigate = (state: S) => {
    if (state.fatalError || state.budgetExhausted) return "report";
    const last = state.messages[state.messages.length - 1];
    if (last instanceof HumanMessage) return state.malformedRetries <= 1 ? "investigate" : "report";
    return last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0 ? "tools" : "report";
  };

  const graph = new StateGraph(State)
    .addNode("investigate", investigate)
    .addNode("tools", executeTools)
    .addNode("report", writeReport)
    .addEdge(START, "investigate")
    .addConditionalEdges("investigate", routeAfterInvestigate, ["tools", "report", "investigate"])
    .addEdge("tools", "investigate")
    .addEdge("report", END)
    .compile();

  emit("START", `Investigation started for ${request.rack_name} (${request.rack_id})`);
  const alerts = request.active_alerts.length
    ? request.active_alerts.map((a) => `- [${a.severity}] ${a.message}`).join("\n")
    : "none";
  const kickoff = new HumanMessage(
    `Investigate rack "${request.rack_id}" (${request.rack_name}, equipment type: ${request.equipment_type}).
Reference time (as_of): ${request.as_of ?? new Date().toISOString()}.
Active alerts:\n${alerts}
Use the tools to gather the evidence you need.`,
  );

  try {
    await graph.invoke(
      { messages: [new SystemMessage(SYSTEM_PROMPT), kickoff] },
      { recursionLimit: opts.maxRounds * 2 + 8 },
    );
  } catch (err) {
    emit("ERROR", `Graph execution failed: ${errMsg(err)}`, "ERROR");
  }

  if (!report) {
    report = {
      ...baseReport("FAILED"),
      severity: "UNKNOWN",
      summary: "Investigation failed before a report could be produced.",
      hypotheses: [],
      recommended_next_inspection: ["Retry the investigation."],
    };
  }
  const final: DiagnosticReport = report;
  emit("END", `Investigation ${final.investigation_status.toLowerCase()}`, final.investigation_status === "FAILED" ? "ERROR" : "SUCCESS");
  return { report: final, events };
}
