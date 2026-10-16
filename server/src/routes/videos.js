import { Router } from "express";
import { z } from "zod";
import { retryVideo, regenerateScript, importScript } from "../services/pipeline/orchestrator.js";
import { listVideos, getVideoDetail, getDetailedExport } from "../services/queries.js";
import { asyncRoute, validateReq, uuidParam } from "../middleware/index.js";
import { notFound } from "../utils/errors.js";
import { videoListQuery, sendExport } from "./shared.js";

const r = Router();


r.get("/", validateReq("query", videoListQuery), asyncRoute(async (req, res) => {
  res.json(await listVideos(req.validQuery));
}));

const exportQuery = z.object({
  format: z.enum(["csv", "xlsx", "json"]).default("csv"),
  ids: z.string().transform(s => s.split(",").filter(Boolean)).pipe(z.array(z.string().uuid()).min(1).max(1000)),
  detailed: z.enum(["true", "false"]).optional(),
});
/** Export selected videos across batches. */
r.get("/export", validateReq("query", exportQuery), asyncRoute(async (req, res) => {
  const { format, ids, detailed } = req.validQuery;
  await sendExport(res, { batchId: undefined, name: "selected-videos", format, scope: "selected", ids, detailed: detailed === "true" });
}));

r.get("/:id", validateReq("params", uuidParam), asyncRoute(async (req, res) => res.json(await getVideoDetail(req.params.id))));

const part = (key, pick) => asyncRoute(async (req, res) => {
  const d = await getVideoDetail(req.params.id);
  const value = pick(d);
  if (!value) throw notFound(key);
  res.json(value);
});
r.get("/:id/transcript", validateReq("params", uuidParam), part("Transcript", d => d.transcript));
r.get("/:id/screenplay", validateReq("params", uuidParam), part("Screenplay analysis", d => d.analysis));
r.get("/:id/match", validateReq("params", uuidParam), part("Match result", d => d.match));
r.get("/:id/story-dna", validateReq("params", uuidParam), part("Story DNA", d => d.storyDna));
r.get("/:id/script", validateReq("params", uuidParam), part("Generated script", d => d.script));
r.get("/:id/export", validateReq("params", uuidParam), asyncRoute(async (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="video-${req.params.id}.json"`);
  res.json((await getDetailedExport([req.params.id]))[0]);
}));

r.post("/:id/retry", validateReq("params", uuidParam), asyncRoute(async (req, res) => res.json(await retryVideo(req.params.id))));
r.post("/:id/regenerate", validateReq("params", uuidParam), asyncRoute(async (req, res) => res.json(await regenerateScript(req.params.id))));

const importBody = z.object({
  content: z.string().min(1).max(60_000),
  skill_identifier: z.string().max(255).optional(),
  skill_version: z.string().max(64).optional(),
});
/** Manual skill workflow: import a script produced in Claude Code. */
r.post("/:id/script", validateReq("params", uuidParam), validateReq("body", importBody), asyncRoute(async (req, res) => {
  const row = await importScript(req.params.id, req.body.content, { skillIdentifier: req.body.skill_identifier, skillVersion: req.body.skill_version });
  res.status(201).json(row);
}));

export default r;
