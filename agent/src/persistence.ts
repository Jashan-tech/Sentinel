// Trusted recording of investigation results in SpacetimeDB (fix/investigation-integrity, issue 5).
// The agent service — not the browser — records each report, using its own SpacetimeDB identity that
// the database admin authorized (`npm run agent:register`). The token stays server-side in agent/.env.

export interface StoredInvestigation {
  investigation_id: string;
  rack_id: string;
  status: string;
  snapshot_json: string;
}
export interface StoredImage {
  image_id: string;
  sha_256: string; // SpacetimeDB column name for `sha256`
}

export interface InvestigationStore {
  load(id: string): Promise<{ row: StoredInvestigation | null; image: StoredImage | null }>;
  complete(id: string, status: string, severity: string, reportJson: string, eventsJson: string): Promise<void>;
}

export class PersistenceError extends Error {}

export interface PersistenceConfig {
  url: string;
  database: string;
  token: string;
}

export function loadPersistenceConfig(env = process.env): PersistenceConfig | null {
  const token = env.SPACETIME_AGENT_TOKEN?.trim();
  if (!token) return null;
  return {
    url: (env.SPACETIME_URL?.trim() || "http://127.0.0.1:3000").replace(/\/$/, ""),
    database: env.SPACETIME_DATABASE?.trim() || "sentinel",
    token,
  };
}

export const INVESTIGATION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createSpacetimeStore(cfg: PersistenceConfig, fetchImpl: typeof fetch = fetch): InvestigationStore {
  const headers = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" };
  const base = `${cfg.url}/v1/database/${encodeURIComponent(cfg.database)}`;

  async function sql<T>(query: string): Promise<T[]> {
    const res = await fetchImpl(`${base}/sql`, { method: "POST", headers, body: query, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new PersistenceError(`SpacetimeDB query failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    const [result] = (await res.json()) as { schema: { elements: { name: { some: string } }[] }; rows: unknown[][] }[];
    const names = result.schema.elements.map((e) => e.name.some);
    return result.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])) as T);
  }

  return {
    async load(id) {
      if (!INVESTIGATION_ID_RE.test(id)) throw new PersistenceError("Invalid investigation id");
      const [row] = await sql<StoredInvestigation>(
        `SELECT investigation_id, rack_id, status, snapshot_json FROM investigation WHERE investigation_id = '${id}'`,
      );
      const [image] = await sql<StoredImage>(`SELECT image_id, sha_256 FROM investigation_image WHERE investigation_id = '${id}'`);
      return { row: row ?? null, image: image ?? null };
    },
    // complete_investigation is idempotent for identical payloads, so transient failures are retried.
    async complete(id, status, severity, reportJson, eventsJson) {
      let last = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(500 * 2 ** attempt);
        try {
          const res = await fetchImpl(`${base}/call/complete_investigation`, {
            method: "POST",
            headers,
            body: JSON.stringify([id, status, severity, reportJson, eventsJson]),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) return;
          last = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
          if (res.status < 500 || res.status === 530) break; // reducer rejected it: retrying won't help
        } catch (err) {
          last = err instanceof Error ? err.message : String(err);
        }
      }
      throw new PersistenceError(`Could not record the investigation in SpacetimeDB (${last})`);
    },
  };
}
