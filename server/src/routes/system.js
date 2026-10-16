import { Router } from "express";
import { existsSync } from "node:fs";
import { db } from "../models/index.js";
import { config } from "../config/env.js";
import { queues } from "../queues/index.js";
import { subscribe } from "../events/bus.js";
import { providers } from "../services/registry.js";
import { getScoringSettings, updateScoringSettings } from "../services/settings.js";
import { dashboardStats } from "../services/queries.js";
import { FFMPEG_PATH, FFPROBE_PATH } from "../services/video/media.js";
import { asyncRoute } from "../middleware/index.js";
import { SCORING_VERSION } from "@reelscript/shared";

const r = Router();

async function providerStatus() {
  const emb = providers.embeddings().info;
  let skill;
  try { skill = await providers.skillAdapter().describe(); } catch (e) { skill = { ready: false, error: e.message }; }
  return {
    downloader: { provider: config.providers.downloader, ready: config.providers.downloader !== "none" },
    transcriber: { provider: config.providers.transcriber, ready: config.providers.transcriber === "mock" || !!config.assemblyai.apiKey, speech_models: config.assemblyai.speechModels },
    analyzer: { provider: config.providers.analyzer, ready: config.providers.analyzer === "mock" || !!config.gemini.apiKey, model: config.gemini.model },
    embeddings: { provider: emb.provider, model: emb.model, semantic: emb.semantic, multilingual: emb.multilingual, calibration: emb.calibration, warning: emb.semantic ? null : "Lexical fallback — configure gemini or local embeddings for meaning-based matching" },
    skill: { ...skill, mode: config.skill.mode },
  };
}

r.get("/settings", asyncRoute(async (_req, res) => {
  res.json({ scoring: await getScoringSettings(), scoring_version: SCORING_VERSION, providers: await providerStatus(), limits: { max_upload_mb: Math.round(config.limits.maxUploadBytes / 1048576), max_rows: config.limits.maxRowsPerBatch, max_video_duration_seconds: config.limits.maxVideoDurationSeconds, media_retention_hours: config.storage.retentionHours } });
}));

r.patch("/settings", asyncRoute(async (req, res) => {
  res.json({ scoring: await updateScoringSettings(req.body?.scoring ?? req.body) });
}));

r.get("/stats", asyncRoute(async (_req, res) => res.json(await dashboardStats())));

r.get("/health", asyncRoute(async (_req, res) => {
  const checks = {};
  try { await db().sequelize.query("SELECT 1"); checks.database = { ok: true }; } catch (e) { checks.database = { ok: false, error: e.message }; }
  try { checks.queue = await queues().health(); } catch (e) { checks.queue = { ok: false, error: e.message }; }
  checks.ffmpeg = { ok: !!FFMPEG_PATH && existsSync(FFMPEG_PATH) };
  checks.ffprobe = { ok: !!FFPROBE_PATH && existsSync(FFPROBE_PATH) };
  const ok = Object.values(checks).every(c => c.ok);
  res.status(ok ? 200 : 503).json({ ok, checks, providers: await providerStatus().catch(e => ({ error: e.message })) });
}));

/** Server-Sent Events: live video + batch progress. Optional ?batchId= filter. */
r.get("/events", (req, res) => {
  const batchId = typeof req.query.batchId === "string" ? req.query.batchId : null;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n");
  const off = subscribe((e) => {
    if (batchId && e.batch_id !== batchId) return;
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); // video | batch | script | dataset
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); off(); });
});

export default r;
