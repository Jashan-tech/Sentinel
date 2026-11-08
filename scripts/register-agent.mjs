// One-time setup: give the agent service its own SpacetimeDB identity and authorize it to record
// investigation reports. Run as the database publisher (your SpacetimeDB CLI login):
//   npm run agent:register                    # database "sentinel" on http://127.0.0.1:3000
//   npm run agent:register -- --database sentinel-verification
// Writes SPACETIME_AGENT_TOKEN / SPACETIME_DATABASE / SPACETIME_URL to agent/.env (git-ignored).
// The token is never printed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spacetimeCli } from "./spacetime.mjs";

export async function registerAgent({ database = "sentinel", server = "http://127.0.0.1:3000", label = "sentinel-agent" } = {}) {
  const res = await fetch(`${server}/v1/identity`, { method: "POST" });
  if (!res.ok) throw new Error(`Could not create an agent identity (HTTP ${res.status}); is SpacetimeDB running?`);
  const { identity, token } = await res.json();
  const call = (...args) => {
    const r = spawnSync(spacetimeCli(), ["call", database, ...args, "--server", server], { encoding: "utf8" });
    if (r.error)
      throw new Error(`Could not run the spacetime CLI (${r.error.message}). Add it to PATH or set SPACETIME_CLI.`);
    return r;
  };
  const claim = call("claim_admin");
  if (claim.status !== 0 && !/already has an admin/.test(claim.stderr + claim.stdout))
    throw new Error(`claim_admin failed: ${(claim.stderr || claim.stdout).trim()}`);
  const auth = call("authorize_agent", JSON.stringify(identity), JSON.stringify(label));
  if (auth.status !== 0)
    throw new Error(
      `authorize_agent failed: ${(auth.stderr || auth.stdout).trim()}\n` +
        "Run this as the identity that published the database (its admin).",
    );
  return { identity, token, database, server };
}

function writeEnv(path, values) {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(path, text, { mode: 0o600 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const r = await registerAgent({ database: arg("database", "sentinel"), server: arg("server", "http://127.0.0.1:3000") });
  const envPath = fileURLToPath(new URL("../agent/.env", import.meta.url));
  writeEnv(envPath, { SPACETIME_AGENT_TOKEN: r.token, SPACETIME_DATABASE: r.database, SPACETIME_URL: r.server });
  console.log(`Authorized agent identity ${r.identity} on database "${r.database}".`);
  console.log("Saved its token to agent/.env (not printed). Restart the agent service to use it.");
}
