import "dotenv/config";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./model.js";

try {
  const cfg = loadConfig();
  console.log(`[sentinel-agent] model=${cfg.model} maxRounds=${cfg.maxRounds}`);
} catch (err) {
  if (err instanceof ConfigError) console.warn(`[sentinel-agent] WARNING: ${err.message}`);
  else throw err;
}

const port = Number(process.env.PORT ?? 3001);
createApp().listen(port, () => {
  console.log(`[sentinel-agent] listening on http://localhost:${port}  (POST /investigate)`);
});
