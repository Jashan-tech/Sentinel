import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { InvestigationRequest } from "./schemas.js";
import { createSnapshotDataSource, createTools } from "./tools.js";
import { runInvestigation, type InvestigatorModel } from "./graph.js";
import { ConfigError, createModel, loadConfig, type AgentConfig } from "./model.js";

export interface AppDeps {
  /** Override for tests; defaults to loading NVIDIA config from env on each request. */
  getModel?: () => { model: InvestigatorModel; config: AgentConfig };
}

export function createApp(deps: AppDeps = {}) {
  const getModel =
    deps.getModel ??
    (() => {
      const config = loadConfig();
      return { model: createModel(config) as unknown as InvestigatorModel, config };
    });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/investigate", async (req: Request, res: Response) => {
    const parsed = InvestigationRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid investigation request", issues: z.treeifyError(parsed.error) });
      return;
    }

    let model: InvestigatorModel, config: AgentConfig;
    try {
      ({ model, config } = getModel());
    } catch (err) {
      if (err instanceof ConfigError) {
        res.status(500).json({ error: "Agent misconfigured", message: err.message });
        return;
      }
      throw err;
    }

    const ds = createSnapshotDataSource(parsed.data, { staleAfterMinutes: config.staleAfterMinutes });
    const result = await runInvestigation(parsed.data, {
      model,
      modelName: config.model,
      tools: createTools(ds),
      maxRounds: config.maxRounds,
      staleAfterMinutes: config.staleAfterMinutes,
    });
    res.status(result.report.investigation_status === "FAILED" ? 502 : 200).json(result);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string })?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body is not valid JSON" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
