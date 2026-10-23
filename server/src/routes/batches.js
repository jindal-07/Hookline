import { Router } from "express";
import { analysisPreview } from "../services/dataset/datasetService.js";
import { z } from "zod";
import { db } from "../models/index.js";
import { config } from "../config/env.js";
import { parseSpreadsheet, validationReportCsv } from "../services/excel/ExcelParser.js";
import { startBatch, cancelBatch, deleteBatch, deleteCancelledBatches } from "../services/pipeline/orchestrator.js";
import { listVideos, dashboardStats, usageForBatch } from "../services/queries.js";
import { asyncRoute, validateReq, uuidParam, upload, uploadLimiter } from "../middleware/index.js";
import { badRequest, notFound } from "../utils/errors.js";
import { videoListQuery, sendExport } from "./shared.js";

const r = Router();
const M = () => db().models;
const safeFilename = (s) => String(s).replace(/[^\w.-]+/g, "_").slice(0, 80);

/** Upload + validate a spreadsheet → DRAFT batch with a preview. Processing starts separately. */
r.post("/", uploadLimiter, upload.single("file"), asyncRoute(async (req, res) => {
  if (!req.file) throw badRequest('Attach the spreadsheet as multipart field "file"');
  const purpose = req.body?.purpose === "dataset" ? "dataset" : "generation";
  const parsed = parseSpreadsheet(req.file.buffer, { filename: req.file.originalname, allowedHosts: config.downloader.allowedHosts, maxRows: config.limits.maxRowsPerBatch, purpose });
  const { sequelize, models } = db();
  // Imported transcript/screenplay text lives on the video; the stored report and the preview carry sizes only.
  const lite = (row) => (row.import ? { ...row, import: undefined, screenplay_chars: row.import.screenplay.length, transcript_chars: row.import.transcript.length, duration_seconds: row.import.duration } : row);
  const batch = await sequelize.transaction(async (transaction) => {
    const b = await models.Batch.create({
      filename: parsed.filename.slice(0, 255),
      purpose,
      validation_report: { summary: parsed.summary, columns: parsed.columns, sheet: parsed.sheet, header_row: parsed.header_row, rows: parsed.rows.map(lite) },
    }, { transaction });
    const valid = parsed.rows.filter(row => row.valid);
    await models.Video.bulkCreate(valid.map(row => ({
      batch_id: b.id, video_url: row.video_url, normalized_url: row.normalized_url, external_id: row.external_id,
      source_row_number: row.row, title: row.title, category: row.category,
      views: row.views, likes: row.likes, shares: row.shares, comments: row.comments,
      performance_label: row.performance,
      ...(row.import ? { media_metadata: { import: row.import } } : {}),
    })), { transaction });
    await b.update({ total_videos: valid.length }, { transaction });
    return b;
  });
  res.status(201).json({
    batch: batch.toJSON(),
    summary: parsed.summary,
    columns: parsed.columns,
    sheet: parsed.sheet,
    header_row: parsed.header_row,
    rows: parsed.rows.slice(0, 1000).map(lite),
    rows_truncated: parsed.rows.length > 1000,
  });
}));

/** Delete all cancelled batches (the only bulk delete allowed). */
r.delete("/", validateReq("query", z.object({ status: z.literal("CANCELLED") })), asyncRoute(async (_req, res) => res.json(await deleteCancelledBatches())));

/** Delete one batch (draft, completed or cancelled) with its videos and derived data. */
r.delete("/:id", validateReq("params", uuidParam), asyncRoute(async (req, res) => res.json(await deleteBatch(req.params.id))));

r.get("/", asyncRoute(async (_req, res) => {
  const batches = await M().Batch.findAll({ order: [["created_at", "DESC"]], limit: 200, attributes: { exclude: ["validation_report"] } });
  res.json({ items: batches });
}));

r.get("/:id", validateReq("params", uuidParam), asyncRoute(async (req, res) => {
  const batch = await M().Batch.findByPk(req.params.id);
  if (!batch) throw notFound("Batch");
  const b = batch.toJSON();
  const report = b.validation_report || {};
  res.json({
    batch: { ...b, validation_report: undefined },
    validation: { summary: report.summary, columns: report.columns, invalid_rows: (report.rows || []).filter(x => !x.valid) },
    stats: await dashboardStats({ batchId: batch.id }),
    usage: await usageForBatch(batch.id),
  });
}));

/** Training batches: the analysed sheet (per-video genre, subgenre, length, hook…) to review before building the dataset. */
r.get("/:id/analysis", validateReq("params", uuidParam), asyncRoute(async (req, res) => res.json(await analysisPreview(req.params.id))));

r.get("/:id/validation-report", validateReq("params", uuidParam), asyncRoute(async (req, res) => {
  const batch = await M().Batch.findByPk(req.params.id);
  if (!batch) throw notFound("Batch");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="validation-${safeFilename(batch.filename)}.csv"`);
  res.send(validationReportCsv({ rows: batch.validation_report.rows || [] }));
}));

r.post("/:id/process", validateReq("params", uuidParam), asyncRoute(async (req, res) => {
  res.json(await startBatch(req.params.id));
}));

r.post("/:id/cancel", validateReq("params", uuidParam), asyncRoute(async (req, res) => {
  res.json(await cancelBatch(req.params.id));
}));

r.get("/:id/videos", validateReq("params", uuidParam), validateReq("query", videoListQuery), asyncRoute(async (req, res) => {
  res.json(await listVideos({ ...req.validQuery, batchId: req.params.id }));
}));

const exportQuery = z.object({
  format: z.enum(["csv", "xlsx", "json"]).default("csv"),
  scope: z.enum(["all", "qualifying", "selected"]).default("all"),
  ids: z.string().optional().transform(s => (s ? s.split(",").filter(Boolean) : undefined)).pipe(z.array(z.string().uuid()).optional()),
  detailed: z.enum(["true", "false"]).optional(),
});

r.get("/:id/export", validateReq("params", uuidParam), validateReq("query", exportQuery), asyncRoute(async (req, res) => {
  const batch = await M().Batch.findByPk(req.params.id);
  if (!batch) throw notFound("Batch");
  const { format, scope, ids, detailed } = req.validQuery;
  if (scope === "selected" && !ids?.length) throw badRequest("scope=selected needs ids");
  await sendExport(res, { batchId: batch.id, name: `${safeFilename(batch.filename.replace(/\.\w+$/, ""))}-${scope}`, format, scope, ids, detailed: detailed === "true" });
}));


export default r;
