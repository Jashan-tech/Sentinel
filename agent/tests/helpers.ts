import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { readFileSync } from "node:fs";
import type { InvestigatorModel } from "../src/graph.js";
import type { AgentConfig } from "../src/model.js";
import { InvestigationRequest } from "../src/schemas.js";

export type Step = AIMessage | Error | ((msgs: BaseMessage[]) => AIMessage);

/** Scripted model: each invoke (tool-bound or not) consumes the next step. */
export function fakeModel(steps: Step[]) {
  const calls: BaseMessage[][] = [];
  const next = async (msgs: BaseMessage[]) => {
    calls.push(msgs);
    const s = steps.shift();
    if (!s) throw new Error("fake model: no more scripted responses");
    if (s instanceof Error) throw s;
    return typeof s === "function" ? s(msgs) : s;
  };
  const model: InvestigatorModel = {
    bindTools: () => RunnableLambda.from(next) as any,
    invoke: next,
  };
  return { model, calls };
}

export const toolCall = (name: string, args: Record<string, unknown>, id = `c_${Math.random().toString(36).slice(2)}`) =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });

export const done = () => new AIMessage("Enough evidence.");

export const reportJson = (severity = "CRITICAL") =>
  new AIMessage(
    JSON.stringify({
      severity,
      summary: "Ambient temperature 35.4 C exceeds the configured critical threshold of 33 C.",
      hypotheses: [
        {
          description: "Insufficient cooling airflow to the rack.",
          supporting_evidence: ["Observed 35.4 C", "Critical threshold 33 C"],
          contradicting_evidence: [],
          missing_evidence: ["Cooling system status unavailable"],
        },
      ],
      recommended_next_inspection: ["Inspect airflow at the rack inlet."],
    }),
  );

export const testConfig: AgentConfig = {
  apiKey: "test",
  model: "fake-nemotron",
  baseURL: "http://invalid",
  maxRounds: 5,
  maxOutputTokens: 256,
  staleAfterMinutes: 15,
};

export const fixture = (name: string) =>
  InvestigationRequest.parse(JSON.parse(readFileSync(new URL(`../src/fixtures/${name}.json`, import.meta.url), "utf8")));
export const rawFixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../src/fixtures/${name}.json`, import.meta.url), "utf8"));
