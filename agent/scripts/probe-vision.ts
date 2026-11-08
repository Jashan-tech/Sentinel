// Live check: does ChatOpenAI -> NVIDIA pass a real image to Nemotron VL (with and without tools)?
//   npx tsx scripts/probe-vision.ts test-assets/vision/switch-5port-led-closeup.jpg
import "dotenv/config";
import { readFileSync } from "node:fs";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createModel, loadConfig } from "../src/model.js";

const path = process.argv[2] ?? "test-assets/vision/switch-5port-led-closeup.jpg";
const b64 = readFileSync(path).toString("base64");
const mime = path.endsWith(".png") ? "image/png" : "image/jpeg";
const cfg = loadConfig();
const model = createModel(cfg) as any;
const msg = () =>
  new HumanMessage({
    content: [
      { type: "text", text: "Describe only what is directly visible in this photo in 3 short bullet points: the device, how many ports have a cable plugged in, and any lit LEDs. Say 'unknown' for anything you cannot see." },
      { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
    ],
  });
let t = Date.now();
const r1 = await model.invoke([msg()]);
console.log(`--- no tools (${Date.now() - t} ms, ${b64.length} b64 chars):\n${String(r1.content).slice(0, 700)}`);
const noop = tool(async () => "{}", { name: "get_current_telemetry", description: "Get rack telemetry", schema: z.object({ rack_id: z.string() }) });
t = Date.now();
const r2 = await model.bindTools([noop]).invoke([msg()]);
console.log(`--- tools bound (${Date.now() - t} ms): tool_calls=${JSON.stringify(r2.tool_calls)}\n${String(r2.content).slice(0, 400)}`);
