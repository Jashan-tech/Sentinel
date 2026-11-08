import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { InvestigationRequest } from "./schemas.js";
import { createSnapshotDataSource, createTools } from "./tools.js";
import { runInvestigation, type InvestigatorModel } from "./graph.js";
import { runMultiAgentInvestigation } from "./multiagent.js";
import { ConfigError, createModel, loadConfig, type AgentConfig } from "./model.js";
import { acceptImage, ImageValidationError, type AcceptedImage } from "./images.js";

export interface AppDeps {
  /** Override for tests; defaults to loading NVIDIA config from env on each request. */
  getModel?: () => { model: InvestigatorModel; specialistModel?: InvestigatorModel; visionModel?: InvestigatorModel; config: AgentConfig };
}

export function createApp(deps: AppDeps = {}) {
  const getModel =
    deps.getModel ??
    (() => {
      const config = loadConfig();
      return {
        model: createModel(config) as unknown as InvestigatorModel,
        specialistModel: createModel(config, config.specialistModel) as unknown as InvestigatorModel,
        visionModel: createModel(config, config.visionModel) as unknown as InvestigatorModel,
        config,
      };
    });

  const app = express();
  // Bounded: one image of at most 4 MB (~5.4 MB as base64) plus telemetry.
  app.use(express.json({ limit: "7mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/investigate", async (req: Request, res: Response) => {
    const parsed = InvestigationRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid investigation request", issues: z.treeifyError(parsed.error) });
      return;
    }

    // Distance is collision-only, including for direct API clients. The equipment graph
    // must not receive it as a current reading, historical trend, or alert context.
    parsed.data.current_telemetry = parsed.data.current_telemetry.filter(r => r.metric_type !== "ULTRASONIC_DISTANCE_CM");
    parsed.data.recent_telemetry = parsed.data.recent_telemetry.filter(r => r.metric_type !== "ULTRASONIC_DISTANCE_CM");
    parsed.data.active_alerts = parsed.data.active_alerts.filter(a => a.metric_type !== "ULTRASONIC_DISTANCE_CM");

    // Byte-level image validation (signature, decode, size, dimensions) before any model call.
    let images: AcceptedImage[] = [];
    try {
      images = parsed.data.images.map((i) => acceptImage(i));
    } catch (err) {
      if (err instanceof ImageValidationError) {
        res.status(400).json({ error: "Invalid image", message: err.message });
        return;
      }
      throw err;
    }
    if (images.length && req.query.mode === "single") {
      res.status(400).json({ error: "Images require the multi-agent investigation (omit ?mode=single)" });
      return;
    }

    let model: InvestigatorModel, specialistModel: InvestigatorModel | undefined, visionModel: InvestigatorModel | undefined, config: AgentConfig;
    try {
      ({ model, specialistModel, visionModel, config } = getModel());
    } catch (err) {
      if (err instanceof ConfigError) {
        res.status(500).json({ error: "Agent misconfigured", message: err.message });
        return;
      }
      throw err;
    }

    const staleAfterMinutes = parsed.data.stale_after_minutes ?? config.staleAfterMinutes;
    const ds = createSnapshotDataSource(parsed.data, { staleAfterMinutes });
    // Default: multi-agent. `?mode=single` runs the original single-agent engine.
    const result =
      req.query.mode === "single"
        ? await runInvestigation(parsed.data, {
            model,
            modelName: config.model,
            tools: createTools(ds),
            maxRounds: config.maxRounds,
            staleAfterMinutes,
          })
        : await runMultiAgentInvestigation(parsed.data, {
            supervisorModel: model,
            specialistModel: specialistModel ?? model,
            supervisorModelName: config.model,
            specialistModelName: config.specialistModel,
            dataSource: ds,
            staleAfterMinutes,
            maxDelegations: config.maxDelegations,
            maxSpecialistToolRounds: config.maxSpecialistToolRounds,
            maxVerificationRetries: config.maxVerificationRetries,
            maxInvestigationSeconds: config.maxInvestigationSeconds,
            images,
            visionModel: visionModel ?? specialistModel ?? model,
            visionModelName: config.visionModel,
          });
    res.status(result.report.investigation_status === "FAILED" ? 502 : 200).json(result);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string })?.type === "entity.too.large") {
      res.status(413).json({ error: "Request too large (images are limited to 4 MB)" });
      return;
    }
    if ((err as { type?: string })?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body is not valid JSON" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
