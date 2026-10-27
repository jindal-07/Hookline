// Read-side queries for the API: filtered video lists, details, dashboard stats, usage.
import { Op, QueryTypes } from "sequelize";
import { db } from "../models/index.js";
import { notFound } from "../utils/errors.js";
import { summaryRow, detailedRecord } from "./export/Exporter.js";
import { getScoringSettings } from "./settings.js";
import { sheetEntries } from "./excel/sheetMetadata.js";

const M = () => db().models;

/** Latest row per video for a child table, as a lateral-join-friendly map. */
async function latestFor(table, ids, columns) {
  if (!ids.length) return new Map();
  const rows = await db().sequelize.query(
    `SELECT DISTINCT ON (video_id) video_id, ${columns} FROM ${table} WHERE video_id IN (:ids) ORDER BY video_id, created_at DESC`,
    { replacements: { ids }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map(r => [r.video_id, r]));
}

/**
 * List videos with filters: batchId, status (csv), category, minScore, maxScore,
 * threshold ("above"|"below"), generationStatus (csv), matchStatus, q (url/title search).
 */
export async function listVideos(f = {}) {
  const settings = await getScoringSettings();
  const where = {};
  if (f.batchId) where.batch_id = f.batchId;
  if (f.ids?.length) where.id = f.ids;
  if (f.status) where.status = f.status.split(",");
  if (f.category) where.category = f.category;
  if (f.generationStatus) where.generation_status = f.generationStatus.split(",");
  if (f.q) where[Op.or] = [{ video_url: { [Op.iLike]: `%${f.q}%` } }, { title: { [Op.iLike]: `%${f.q}%` } }];

  // Score filters apply to each video's latest match result.
  const scoreFilter = f.minScore !== undefined || f.maxScore !== undefined || f.threshold || f.matchStatus;
  if (scoreFilter) {
    const conds = [];
    const rep = {};
    if (f.minScore !== undefined) { conds.push("m.overall_score >= :min"); rep.min = f.minScore; }
    if (f.maxScore !== undefined) { conds.push("m.overall_score <= :max"); rep.max = f.maxScore; }
    if (f.threshold === "above") { conds.push("m.overall_score >= :thr"); rep.thr = settings.matchThreshold; }
    if (f.threshold === "below") { conds.push("(m.overall_score < :thr OR m.overall_score IS NULL)"); rep.thr = settings.matchThreshold; }
    if (f.matchStatus) { conds.push("m.match_status IN (:ms)"); rep.ms = f.matchStatus.split(","); }
    const rows = await db().sequelize.query(
      `SELECT m.video_id FROM (SELECT DISTINCT ON (video_id) * FROM match_results ORDER BY video_id, created_at DESC) m WHERE ${conds.join(" AND ")}`,
      { replacements: rep, type: QueryTypes.SELECT }
    );
    const ids = rows.map(r => r.video_id);
    where.id = where.id ? where.id.filter(id => ids.includes(id)) : ids;
  }

  const limit = Math.min(Number(f.limit) || 100, 1000);
  const offset = Number(f.offset) || 0;
  const order = f.sort === "score" ? [["updated_at", "DESC"]] : [["source_row_number", "ASC"], ["created_at", "ASC"]];
  const { rows, count } = await M().Video.findAndCountAll({ where, limit, offset, order });
  const ids = rows.map(v => v.id);
  const [matches, scripts] = await Promise.all([
    latestFor("match_results", ids, "overall_score, story_score, character_score, dialogue_score, confidence, match_status, eligible"),
    latestFor("generated_scripts", ids, "generation_status"),
  ]);
  let items = rows.map(v => ({ ...v.toJSON(), video_path: undefined, audio_path: undefined, match: matches.get(v.id) || null, script_status: scripts.get(v.id)?.generation_status || null }));
  if (f.sort === "score") items = items.sort((a, b) => (b.match?.overall_score ?? -1) - (a.match?.overall_score ?? -1));
  return { items, total: count, limit, offset, threshold: settings.matchThreshold };
}

const latest = (Model, video_id) => Model.findOne({ where: { video_id }, order: [["created_at", "DESC"]] });

export async function getVideoDetail(id) {
  const { Video, Transcript, ScreenplayAnalysis, MatchResult, StoryDNA, GeneratedScript, ProcessingLog, Batch } = M();
  const video = await Video.findByPk(id);
  if (!video) throw notFound("Video");
  const [batch, transcript, analysis, match, storyDna, script, scripts, logs] = await Promise.all([
    Batch.findByPk(video.batch_id, { attributes: ["id", "filename", "status"] }),
    latest(Transcript, id), latest(ScreenplayAnalysis, id), latest(MatchResult, id), latest(StoryDNA, id), latest(GeneratedScript, id),
    GeneratedScript.findAll({ where: { video_id: id }, order: [["created_at", "DESC"]], attributes: ["id", "generation_status", "skill_identifier", "skill_version", "created_at"] }),
    ProcessingLog.findAll({ where: { video_id: id }, order: [["created_at", "ASC"]] }),
  ]);
  const v = video.toJSON();
  delete v.video_path; delete v.audio_path;
  v.sheet_metadata = sheetEntries(v.media_metadata?.sheet);
  return { video: v, batch, transcript, analysis, match, storyDna, script, scriptHistory: scripts, logs };
}

export async function getDetailedExport(ids) {
  const out = [];
  for (const id of ids) {
    const d = await getVideoDetail(id);
    out.push(detailedRecord({ video: d.video, transcript: d.transcript, analysis: d.analysis, match: d.match, storyDna: d.storyDna, script: d.script, logs: d.logs }));
  }
  return out;
}

/** Summary rows for export. scope: "all" | "qualifying" | "selected". */
export async function exportRows({ batchId, scope = "all", ids }) {
  const filters = { batchId, limit: 1000 };
  if (scope === "selected") filters.ids = ids || [];
  if (scope === "qualifying") filters.matchStatus = "MATCHED";
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await listVideos({ ...filters, offset });
    const vids = page.items.map(v => v.id);
    const scripts = await latestFor("generated_scripts", vids, "generation_status, script_content");
    rows.push(...page.items.map(v => summaryRow(v, v.match, scripts.get(v.id))));
    if (offset + page.items.length >= page.total || !page.items.length) break;
  }
  return rows;
}

export async function dashboardStats({ batchId } = {}) {
  const settings = await getScoringSettings();
  const filter = batchId ? "WHERE v.batch_id = :batchId" : "";
  const [row] = await db().sequelize.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE v.status NOT IN ('COMPLETED','INCONCLUSIVE','SKIPPED_LOW_SCORE','FAILED','CANCELLED','PENDING'))::int AS processing,
      COUNT(*) FILTER (WHERE v.status = 'PENDING')::int AS pending,
      COUNT(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE v.status = 'FAILED')::int AS failed,
      COUNT(*) FILTER (WHERE v.status = 'INCONCLUSIVE')::int AS inconclusive,
      COUNT(*) FILTER (WHERE v.status = 'SKIPPED_LOW_SCORE')::int AS skipped,
      COUNT(*) FILTER (WHERE m.overall_score >= :thr)::int AS above_threshold,
      COUNT(*) FILTER (WHERE m.eligible)::int AS eligible,
      COUNT(*) FILTER (WHERE v.generation_status = 'COMPLETED')::int AS scripts_generated,
      AVG(m.overall_score) AS avg_score,
      AVG(m.confidence) AS avg_confidence
    FROM videos v
    LEFT JOIN (SELECT DISTINCT ON (video_id) * FROM match_results ORDER BY video_id, created_at DESC) m ON m.video_id = v.id
    ${filter}`, { replacements: { thr: settings.matchThreshold, batchId }, type: QueryTypes.SELECT });

  const dist = await db().sequelize.query(`
    SELECT LEAST(FLOOR(m.overall_score / 10), 9)::int AS bucket, (m.overall_score >= :thr) AS above, COUNT(*)::int AS n
    FROM (SELECT DISTINCT ON (video_id) * FROM match_results ORDER BY video_id, created_at DESC) m
    JOIN videos v ON v.id = m.video_id
    WHERE m.overall_score IS NOT NULL ${batchId ? "AND v.batch_id = :batchId" : ""}
    GROUP BY 1, 2 ORDER BY 1`, { replacements: { thr: settings.matchThreshold, batchId }, type: QueryTypes.SELECT });

  return {
    ...row,
    avg_score: row.avg_score === null ? null : Number(row.avg_score),
    avg_confidence: row.avg_confidence === null ? null : Number(row.avg_confidence),
    threshold: settings.matchThreshold,
    score_distribution: scoreBuckets(dist, settings.matchThreshold),
  };
}

/**
 * Ten-point buckets, except the one containing the threshold, which is split at it (75 → "70–74" below, "75–79" above),
 * so the above-threshold bars always add up to the "Above threshold" count.
 * @param {{ bucket: number, above: boolean, n: number }[]} rows  counts per decade and side of the threshold
 */
export function scoreBuckets(rows, threshold) {
  const count = (i, above) => rows.filter(r => r.bucket === i && (above === undefined || r.above === above)).reduce((t, r) => t + r.n, 0);
  const out = [];
  for (let i = 0; i < 10; i++) {
    const lo = i * 10, hi = lo + 9;
    if (threshold > lo && threshold <= hi) {
      const t = Math.ceil(threshold);
      out.push({ bucket: `${lo}–${t - 1}`, from: lo, count: count(i, false), above: false });
      out.push({ bucket: `${t}–${hi}`, from: t, count: count(i, true), above: true });
    } else {
      out.push({ bucket: `${lo}–${hi}`, from: lo, count: count(i), above: lo >= threshold });
    }
  }
  return out;
}

/** Provider usage + latency recorded in processing logs (tokens, audio seconds, skill cost). */
export async function usageForBatch(batchId) {
  const rows = await db().sequelize.query(`
    SELECT stage,
      COUNT(*)::int AS runs,
      AVG(duration_ms)::int AS avg_ms,
      SUM(COALESCE((metadata->'usage'->>'prompt_tokens')::numeric, 0))::bigint AS prompt_tokens,
      SUM(COALESCE((metadata->'usage'->>'output_tokens')::numeric, 0))::bigint AS output_tokens,
      SUM(COALESCE((metadata->'usage'->>'audio_seconds')::numeric, 0))::numeric AS audio_seconds,
      SUM(COALESCE((metadata->>'cost_usd')::numeric, 0))::numeric AS cost_usd
    FROM processing_logs WHERE batch_id = :batchId AND status = 'SUCCEEDED'
    GROUP BY stage ORDER BY stage`, { replacements: { batchId }, type: QueryTypes.SELECT });
  return rows.map(r => ({ ...r, audio_seconds: Number(r.audio_seconds), cost_usd: Number(r.cost_usd), prompt_tokens: Number(r.prompt_tokens), output_tokens: Number(r.output_tokens) }));
}
