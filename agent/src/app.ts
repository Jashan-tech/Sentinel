import { createProgressPublisher } from "./progress.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { ImageInput, InvestigationRequest, MAX_IMAGES } from "./schemas.js";
import { createSpacetimeStore, INVESTIGATION_ID_RE, loadPersistenceConfig, type InvestigationStore } from "./persistence.js";
import { createSnapshotDataSource, createTools } from "./tools.js";
import { runInvestigation, type InvestigatorModel } from "./graph.js";
import { runMultiAgentInvestigation } from "./multiagent.js";
import { ConfigError, createModel, loadConfig, type AgentConfig } from "./model.js";
import { acceptImage, ImageValidationError, type AcceptedImage } from "./images.js";

export interface AppDeps {
  /** Override for tests; defaults to loading NVIDIA config from env on each request. */
  getModel?: () => { model: InvestigatorModel; specialistModel?: InvestigatorModel; visionModel?: InvestigatorModel; config: AgentConfig };
  /** Where reports are recorded. Defaults to SpacetimeDB via SPACETIME_AGENT_TOKEN; null disables persisted mode. */
  store?: InvestigationStore | null;
}

/** Persisted mode: the browser names a RUNNING investigation it started; the agent runs on the STORED snapshot. */
const PersistedRequest = z.object({
  investigation_id: z.string().regex(INVESTIGATION_ID_RE),
  images: z.array(ImageInput).max(MAX_IMAGES).default([]),
});

class HttpError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body.message ?? body.error));
  }
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
  const store = deps.store !== undefined ? deps.store : (() => {
    const cfg = loadPersistenceConfig();
    return cfg ? createSpacetimeStore(cfg) : null;
  })();

  const app = express();
  // Bounded: one image of at most 4 MB (~5.4 MB as base64) plus telemetry.
  app.use(express.json({ limit: "7mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, records_investigations: Boolean(store) });
  });

  function acceptAll(inputs: InvestigationRequest["images"]): AcceptedImage[] {
    try {
      return inputs.map((i) => acceptImage(i));
    } catch (err) {
      if (err instanceof ImageValidationError) throw new HttpError(400, { error: "Invalid image", message: err.message });
      throw err;
    }
  }

  /** Load the stored investigation and build the request from its snapshot plus verified image bytes. */
  async function fromStore(body: z.infer<typeof PersistedRequest>) {
    if (!store)
      throw new HttpError(503, {
        error: "Agent cannot record investigations",
        message: "The agent service has no SpacetimeDB identity. Run `npm run agent:register` and restart the agent.",
      });
    let loaded;
    try {
      loaded = await store.load(body.investigation_id);
    } catch (err) {
      throw new HttpError(502, { error: "SpacetimeDB unavailable", message: err instanceof Error ? err.message : String(err) });
    }
    const { row, image } = loaded;
    if (!row) throw new HttpError(404, { error: "Unknown investigation", message: `Investigation ${body.investigation_id} was not found in SpacetimeDB` });
    if (row.status !== "RUNNING") throw new HttpError(409, { error: "Investigation is not running", message: `Investigation is already ${row.status}` });
    let snapshot: Record<string, unknown>;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch {
      throw new HttpError(400, { error: "Stored snapshot is not valid JSON" });
    }
    const storedImages = Array.isArray(snapshot.images) ? (snapshot.images as { image_id?: string; sha256?: string }[]) : [];
    const parsed = InvestigationRequest.safeParse({ ...snapshot, images: body.images });
    if (!parsed.success)
      throw new HttpError(400, { error: "Stored snapshot is not a valid investigation request", issues: z.treeifyError(parsed.error) });
    if (parsed.data.rack_id !== row.rack_id) throw new HttpError(400, { error: "Stored snapshot rack does not match the investigation" });
    const images = acceptAll(parsed.data.images);
    // The bytes analyzed must be exactly the image whose provenance was recorded for this investigation.
    if (images.length !== storedImages.length) throw new HttpError(400, { error: "Image mismatch", message: "The images sent do not match the stored investigation" });
    for (const [i, img] of images.entries()) {
      const want = storedImages[i];
      const recorded = image && image.image_id === img.provenance.image_id ? image.sha_256 : undefined;
      if (want?.image_id !== img.provenance.image_id || want?.sha256 !== img.provenance.sha256 || (image && recorded !== img.provenance.sha256))
        throw new HttpError(400, { error: "Image mismatch", message: `Image ${img.provenance.image_id} does not match the SHA-256 recorded for this investigation` });
    }
    return { request: parsed.data, images };
  }

  app.post("/investigate", async (req: Request, res: Response) => {
    const persisted = req.body && typeof req.body === "object" && "investigation_id" in req.body;
    let request: InvestigationRequest;
    let images: AcceptedImage[];
    let investigationId: string | undefined;
    try {
      if (persisted) {
        const p = PersistedRequest.safeParse(req.body);
        if (!p.success) throw new HttpError(400, { error: "Invalid investigation request", issues: z.treeifyError(p.error) });
        if (req.query.mode === "single") throw new HttpError(400, { error: "Recorded investigations use the multi-agent engine (omit ?mode=single)" });
        investigationId = p.data.investigation_id;
        ({ request, images } = await fromStore(p.data));
      } else {
        const parsed = InvestigationRequest.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, { error: "Invalid investigation request", issues: z.treeifyError(parsed.error) });
        request = parsed.data;
        // Byte-level image validation (signature, full decode, size, dimensions) before any model call.
        images = acceptAll(parsed.data.images);
        if (images.length && req.query.mode === "single")
          throw new HttpError(400, { error: "Images require the multi-agent investigation (omit ?mode=single)" });
      }
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json(err.body);
        return;
      }
      throw err;
    }

    // Collision safety remains outside equipment reasoning in both stored and stateless requests.
    request.current_telemetry = request.current_telemetry.filter(r => r.metric_type !== "ULTRASONIC_DISTANCE_CM");
    request.recent_telemetry = request.recent_telemetry.filter(r => r.metric_type !== "ULTRASONIC_DISTANCE_CM");
    request.active_alerts = request.active_alerts.filter(a => a.metric_type !== "ULTRASONIC_DISTANCE_CM");

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

    // Stateless requests are cancelled when the client disconnects (issue 7). Recorded investigations keep
    // running and are recorded by the agent, so a closed browser no longer leaves them RUNNING.
    const cancel = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) cancel.abort();
    };
    if (!persisted) res.on("close", onClose);

    // Live progress for recorded runs: every dashboard subscribed to this rack sees which agent is working.
    const progress =
      persisted && investigationId && store?.progress
        ? createProgressPublisher(
            (p) => store.progress!(investigationId!, p.phase, JSON.stringify(p.steps)),
            (m) => console.warn(`[sentinel-agent] ${m}`),
          )
        : null;
    const staleAfterMinutes = request.stale_after_minutes ?? config.staleAfterMinutes;
    const ds = createSnapshotDataSource(request, { staleAfterMinutes });
    // Default: multi-agent. `?mode=single` runs the original single-agent engine.
    const result =
      req.query.mode === "single"
        ? await runInvestigation(request, {
            model,
            modelName: config.model,
            tools: createTools(ds),
            maxRounds: config.maxRounds,
            staleAfterMinutes,
          })
        : await runMultiAgentInvestigation(request, {
            supervisorModel: model,
            specialistModel: specialistModel ?? model,
            supervisorModelName: config.model,
            specialistModelName: config.specialistModel,
            dataSource: ds,
            staleAfterMinutes,
            maxDelegations: config.maxDelegations,
            maxSpecialistToolRounds: config.maxSpecialistToolRounds,
            maxVerificationToolRounds: config.maxVerificationToolRounds,
            maxVerificationRetries: config.maxVerificationRetries,
            maxInvestigationSeconds: images.length
              ? Math.max(config.maxInvestigationSeconds, config.maxVisualInvestigationSeconds ?? 0)
              : config.maxInvestigationSeconds,
            images,
            visionModel: visionModel ?? specialistModel ?? model,
            visionModelName: config.visionModel,
            signal: cancel.signal,
            onEvent: progress?.onEvent,
          });
    res.off("close", onClose);

    if (persisted && investigationId && store) {
      const r = result.report;
      try {
        await store.complete(investigationId, r.investigation_status, r.severity, JSON.stringify(r), JSON.stringify(result.events));
      } catch (err) {
        res.status(502).json({ ...result, persisted: false, persist_error: err instanceof Error ? err.message : String(err) });
        return;
      }
      res.status(r.investigation_status === "FAILED" ? 502 : 200).json({ ...result, persisted: true, investigation_id: investigationId });
      return;
    }
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
