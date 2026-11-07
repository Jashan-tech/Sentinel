import "dotenv/config";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createModel, loadConfig } from "../src/model.js";
const t = tool(async () => "{}", { name: "get_rack_profile", description: "Get rack profile", schema: z.object({ rack_id: z.string() }) });
for (const m of process.argv.slice(2)) {
  const cfg = { ...loadConfig(), model: m };
  const t0 = Date.now();
  try {
    const r = await (createModel(cfg) as any).bindTools([t]).invoke("Look up the rack profile for rack-001 using the tool.");
    console.log(m, `${Date.now() - t0}ms`, "tool_calls=", JSON.stringify(r.tool_calls), "content=", JSON.stringify(String(r.content).slice(0, 80)));
  } catch (e) { console.log(m, "ERROR", String((e as Error).message).replace(/nvapi-\S+/g, "nvapi-***").slice(0, 200)); }
}
