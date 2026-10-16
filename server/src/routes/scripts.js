// Standalone episode scripts generated from the training dataset (Scripts tab).
import { Router } from "express";
import { z } from "zod";
import { db } from "../models/index.js";
import { createScripts, regenerateStandalone, importStandalone } from "../services/pipeline/orchestrator.js";
import { asyncRoute, validateReq, uuidParam } from "../middleware/index.js";
import { scriptToDocx, scriptToPdf, scriptFileName } from "../services/export/ScriptDocument.js";
import { notFound } from "../utils/errors.js";

const r = Router();
const M = () => db().models;

r.get("/", asyncRoute(async (_req, res) => {
  const items = await M().Script.findAll({ order: [["created_at", "DESC"]], limit: 200, attributes: { exclude: ["content", "generation_metadata"] } });
  res.json({ items });
}));

const createBody = z.object({
  datasetId: z.string().uuid().optional(),
  genre: z.string().min(1).max(128),
  subgenre: z.string().max(128).optional().nullable(),
  targetDurationSeconds: z.number().int().min(10).max(1800).optional(),
  language: z.string().min(2).max(16).optional(),
  premise: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  count: z.number().int().min(1).max(5).default(1),
}).strict();

r.post("/", validateReq("body", createBody), asyncRoute(async (req, res) => {
  const rows = await createScripts({ ...req.body, subgenre: req.body.subgenre || undefined });
  res.status(201).json({ items: rows });
}));

r.get("/:id", validateReq("params", uuidParam), asyncRoute(async (req, res) => {
  const s = await M().Script.findByPk(req.params.id);
  if (!s) throw notFound("Script");
  res.json(s);
}));

const downloadQuery = z.object({ format: z.enum(["docx", "pdf", "md"]).default("docx") });
/** Download a script: Word (.docx, default), PDF, or the original Markdown. */
r.get("/:id/download", validateReq("params", uuidParam), validateReq("query", downloadQuery), asyncRoute(async (req, res) => {
  const s = await M().Script.findByPk(req.params.id);
  if (!s?.content) throw notFound("Script content");
  const { format } = req.validQuery;
  const script = s.toJSON();
  const [type, body] = format === "pdf" ? ["application/pdf", await scriptToPdf(script)]
    : format === "md" ? ["text/markdown; charset=utf-8", s.content]
    : ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", await scriptToDocx(script)];
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${scriptFileName(script, format)}"`);
  res.send(body);
}));

r.post("/:id/regenerate", validateReq("params", uuidParam), asyncRoute(async (req, res) => res.json(await regenerateStandalone(req.params.id))));

const importBody = z.object({ content: z.string().min(1).max(100_000) });
r.post("/:id/import", validateReq("params", uuidParam), validateReq("body", importBody), asyncRoute(async (req, res) => {
  res.json(await importStandalone(req.params.id, req.body.content));
}));

r.delete("/:id", validateReq("params", uuidParam), asyncRoute(async (req, res) => {
  const s = await M().Script.findByPk(req.params.id);
  if (!s) throw notFound("Script");
  await s.destroy();
  res.json({ ok: true });
}));

export default r;
