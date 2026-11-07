import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
export function spacetimeCli() {
  if (process.env.SPACETIME_CLI) return process.env.SPACETIME_CLI;
  const installed =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "SpacetimeDB", "spacetime.exe")
      : "";
  return installed && existsSync(installed) ? installed : "spacetime";
}
if (process.argv[1]?.endsWith("spacetime.mjs")) {
  const result = spawnSync(spacetimeCli(), process.argv.slice(2), {
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
