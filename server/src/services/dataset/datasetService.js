// Loads labelled training videos from the database and stores dataset snapshots.
import { Op } from "sequelize";
import { BATCH_PURPOSE } from "@reelscript/shared";
import { db } from "../../models/index.js";
import { publish } from "../../events/bus.js";
import { badRequest, notFound } from "../../utils/errors.js";
import { buildDatasetProfile, extractFeatures, BUILDER_VERSION } from "./DatasetBuilder.js";

const M = () => db().models;
const latest = (Model, video_id) => Model.findOne({ where: { video_id }, order: [["created_at", "DESC"]] });

/** Labelled, analysed videos of the given training batches (one per URL; latest label wins), plus the ones that can't be used. */
async function loadTrainingItems(batches, excludeIds = new Set()) {
  const { Video, ScreenplayAnalysis, Transcript, StoryDNA, MatchResult } = M();
  const videos = await Video.findAll({ where: { batch_id: batches.map(b => b.id), cancelled: false }, order: [["source_row_number", "ASC"]] });
  const byUrl = new Map();
  for (const v of videos) byUrl.set(v.normalized_url, v);

  const items = [], excluded = [];
  for (const v of byUrl.values()) {
    if (excludeIds.has(v.id)) { excluded.push({ video_id: v.id, url: v.video_url, reason: "excluded during review" }); continue; }
    if (!v.performance_label) { excluded.push({ video_id: v.id, url: v.video_url, reason: "no performance label" }); continue; }
    const analysis = await latest(ScreenplayAnalysis, v.id);
    if (!analysis) { excluded.push({ video_id: v.id, url: v.video_url, reason: v.status === "FAILED" ? `failed: ${v.error_message || v.error_code}` : `not analysed yet (${v.status})` }); continue; }
    const [transcript, dna, match] = await Promise.all([latest(Transcript, v.id), latest(StoryDNA, v.id), latest(MatchResult, v.id)]);
    items.push({ video: v.toJSON(), analysis: analysis.normalized_analysis, transcript: transcript?.normalized_transcript || null, storyDna: dna?.story_dna || null, match: match?.toJSON() || null });
  }
  return { items, excluded };
}

/**
 * Build a new dataset snapshot from training batches (all of them by default).
 * Only labelled videos with a stored screenplay analysis are used; everything else is listed as excluded.
 * `excludeVideoIds` are rows the user unticked while reviewing the analysed sheet.
 */
export async function buildDataset({ batchIds, name, excludeVideoIds } = {}) {
  const { Batch, Dataset } = M();
  const where = { purpose: BATCH_PURPOSE.DATASET };
  if (batchIds?.length) where.id = batchIds;
  const batches = await Batch.findAll({ where, order: [["created_at", "ASC"]] });
  if (!batches.length) throw badRequest("No training-dataset batches found. Upload a spreadsheet with purpose “Training dataset” first.");

  const { items, excluded } = await loadTrainingItems(batches, new Set(excludeVideoIds || []));
  if (!items.length) throw badRequest("No analysed, labelled videos yet — wait for the training batch to finish processing.");

  const profile = buildDatasetProfile(items, excluded);
  const ds = await Dataset.create({
    name: name || `Dataset ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    source_batch_ids: batches.map(b => b.id),
    video_count: profile.overview.videos,
    best_count: profile.overview.best,
    bad_count: profile.overview.bad,
    excluded,
    profile,
    builder_version: BUILDER_VERSION,
  });
  publish({ type: "dataset", dataset_id: ds.id, videos: ds.video_count });
  return ds;
}

export async function latestDataset() {
  return M().Dataset.findOne({ order: [["created_at", "DESC"]] });
}

export async function getDataset(id) {
  const ds = await M().Dataset.findByPk(id);
  if (!ds) throw notFound("Dataset");
  return ds;
}

export async function listDatasets() {
  return M().Dataset.findAll({ order: [["created_at", "DESC"]], limit: 50, attributes: { exclude: ["profile", "excluded"] } });
}

/** Source material for originality checks of standalone scripts: every dataset video's lines and names. */
export async function datasetCorpus(dataset) {
  const { Batch, Video, Transcript, ScreenplayAnalysis } = M();
  const batches = await Batch.findAll({ where: { id: dataset.source_batch_ids } });
  const videos = await Video.findAll({ where: { batch_id: batches.map(b => b.id), performance_label: { [Op.ne]: null } }, attributes: ["id"] });
  const lines = [], names = [], overlays = [];
  for (const v of videos) {
    const [t, a] = await Promise.all([latest(Transcript, v.id), latest(ScreenplayAnalysis, v.id)]);
    if (t) for (const seg of [...t.normalized_transcript.dialogue_segments, ...t.normalized_transcript.narration_segments, ...t.normalized_transcript.uncertain_segments]) lines.push(seg.text);
    if (a) {
      names.push(...a.normalized_analysis.characters.map(c => c.label));
      overlays.push(...a.normalized_analysis.visual_storytelling.text_overlays.map(o => o.detail));
      lines.push(...a.normalized_analysis.dialogue_moments.map(m => m.summary));
    }
  }
  return { lines, names: [...new Set(names)], overlays };
}

/**
 * The analysed sheet of one training batch, for review before the dataset is built:
 * one row per spreadsheet video with exactly the features the dataset will compare.
 */
export async function analysisPreview(batchId) {
  const { Batch, Video, ScreenplayAnalysis, Transcript, StoryDNA, MatchResult } = M();
  const batch = await Batch.findByPk(batchId);
  if (!batch) throw notFound("Batch");
  if (batch.purpose !== BATCH_PURPOSE.DATASET) throw badRequest("Only training-dataset batches have an analysis preview.");
  const videos = await Video.findAll({ where: { batch_id: batch.id }, order: [["source_row_number", "ASC"]] });
  const rows = [];
  for (const v of videos) {
    const base = { video_id: v.id, row: v.source_row_number, url: v.video_url, title: v.title, label: v.performance_label, status: v.status, views: v.views, error: v.status === "FAILED" ? v.error_message || v.error_code : null };
    const analysis = await latest(ScreenplayAnalysis, v.id);
    if (!analysis || v.cancelled) { rows.push({ ...base, analysed: false }); continue; }
    const [transcript, dna, match] = await Promise.all([latest(Transcript, v.id), latest(StoryDNA, v.id), latest(MatchResult, v.id)]);
    const f = extractFeatures({ video: v.toJSON(), analysis: analysis.normalized_analysis, transcript: transcript?.normalized_transcript || null, storyDna: dna?.story_dna || null, match: match?.toJSON() || null });
    rows.push({
      ...base, analysed: true,
      genre: f.genre, subgenre: f.subgenre, duration: f.duration, scene_count: f.scene_count, language: f.language,
      hook_pattern: f.single.hook_pattern, ending_type: f.single.ending_type, pacing: f.single.pacing,
      emotional_arc: f.multi.emotion, narrative_format: f.single.narrative_format,
    });
  }
  const ds = await latestDataset();
  const usable = rows.filter(r => r.analysed && r.label);
  return {
    batch: { id: batch.id, filename: batch.filename, status: batch.status },
    rows,
    summary: { total: rows.length, analysed: rows.filter(r => r.analysed).length, usable: usable.length, best: usable.filter(r => r.label === "best").length, bad: usable.filter(r => r.label === "bad").length, failed: rows.filter(r => r.status === "FAILED").length },
    in_dataset: ds ? { id: ds.id, name: ds.name, created_at: ds.created_at, included: (ds.source_batch_ids || []).includes(batch.id) } : null,
  };
}
