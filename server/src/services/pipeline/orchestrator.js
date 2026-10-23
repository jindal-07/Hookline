// Video-processing state machine and stage handlers.
//
//   download → audio → ┬→ transcribe ┐
//                      └→ analyze    ┴→ match → (eligible) → generate
//
// Every handler is idempotent: it checks persisted output first, so retries and worker restarts
// never redo completed work. Stage results are persisted as soon as they exist (partial results survive).
import { existsSync } from "node:fs";
import { rm, stat, utimes } from "node:fs/promises";
import { Op } from "sequelize";
import { VIDEO_STATUS, TASK_STATUS, BATCH_STATUS, GENERATION_STATUS, MATCH_STATUS, STAGES, TERMINAL_STATUSES, BATCH_PURPOSE, SCRIPT_STATUS } from "@reelscript/shared";
import { db } from "../../models/index.js";
import { config } from "../../config/env.js";
import { queues, jobIdFor } from "../../queues/index.js";
import { publish } from "../../events/bus.js";
import { providers } from "../registry.js";
import { TranscriptNormalizer } from "../normalization/TranscriptNormalizer.js";
import { normalizeScreenplay } from "../screenplay/ScreenplayNormalizer.js";
import { MatchingService } from "../matching/MatchingService.js";
import { StoryDNABuilder } from "../generation/StoryDNABuilder.js";
import { ScriptGenerationService, summarizeTranscript } from "../generation/ScriptGenerationService.js";
import { getScoringSettings } from "../settings.js";
import { sha256File } from "../video/media.js";
import { validate } from "../../utils/schema.js";
import { getDataset, latestDataset, datasetCorpus } from "../dataset/datasetService.js";
import { rawTranscriptFromText } from "../importing/textImport.js";

/** Training video imported with transcript + screenplay text: analysed from text, never downloaded. */
const importedText = (video) => video.media_metadata?.import || null;
import { playbookFor } from "../dataset/DatasetBuilder.js";
import { classifyError, permanent, badRequest, conflict, notFound } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

const M = () => db().models;

// ---------------- helpers ----------------

export function videoEvent(v) {
  return {
    type: "video",
    video_id: v.id, batch_id: v.batch_id, status: v.status, current_stage: v.current_stage,
    transcript_status: v.transcript_status, analysis_status: v.analysis_status, generation_status: v.generation_status,
    error_code: v.error_code, error_message: v.error_message,
  };
}

/**
 * Update a video and broadcast it. Status changes are conditional on the video not having been
 * cancelled meanwhile, so an in-flight handler can never overwrite CANCELLED. Likewise a progress update
 * from a concurrent stage (e.g. analysis finishing after transcription failed) can never overwrite FAILED;
 * only an explicit user action (retry/regenerate reset `cancelled`; script import passes `force`) leaves it.
 */
async function setVideo(video, patch, { force = false } = {}) {
  if ("status" in patch && !("cancelled" in patch)) {
    const where = { id: video.id, cancelled: false };
    if (!force && patch.status !== VIDEO_STATUS.FAILED) where.status = { [Op.ne]: VIDEO_STATUS.FAILED };
    const [n] = await M().Video.update(patch, { where });
    await video.reload();
    if (!n) return video; // cancelled concurrently — leave it alone
  } else {
    await video.update(patch);
  }
  publish(videoEvent(video));
  return video;
}

async function logStage(video, stage, status, { attempt, durationMs, error, metadata } = {}) {
  await M().ProcessingLog.create({
    batch_id: video.batch_id, video_id: video.id, stage, status, attempt: attempt ?? null,
    duration_ms: durationMs ?? null,
    error_details: error ? { code: error.code || "UNEXPECTED", message: String(error.message).slice(0, 2000), permanent: !!error.permanent } : null,
    metadata: metadata || {},
  });
}

async function enqueue(stage, videoId) {
  return queues().add(stage, { videoId }, { jobId: jobIdFor(stage, videoId) });
}

const latest = (Model, videoId) => Model.findOne({ where: { video_id: videoId }, order: [["created_at", "DESC"]] });

/** Load the video and decide whether this stage should run at all. */
async function loadForStage(videoId) {
  const video = await M().Video.findByPk(videoId);
  if (!video) return null;
  if (video.cancelled || video.status === VIDEO_STATUS.CANCELLED) return null;
  if (video.status === VIDEO_STATUS.FAILED) return null; // a parallel task failed permanently; retry restarts it
  return video;
}

/** Wrap a stage body with timing, logging and error classification. */
function stageHandler(stage, body) {
  const handler = async (job) => {
    const { videoId } = job.data;
    const video = await loadForStage(videoId);
    if (!video) return { skipped: true };
    const started = Date.now();
    const attempt = job.attemptsMade ?? 1;
    try {
      const metadata = await body(video, { attempt });
      if (metadata !== false) await logStage(video, stage, "SUCCEEDED", { attempt, durationMs: Date.now() - started, metadata: metadata || {} });
      await refreshBatch(video.batch_id);
      return { ok: true };
    } catch (e) {
      const err = classifyError(e);
      await logStage(video, stage, "ATTEMPT_FAILED", { attempt, durationMs: Date.now() - started, error: err });
      throw err;
    }
  };
  handler.onFinalFailure = async (job, err) => markFailed(job.data.videoId, stage, classifyError(err.cause || err));
  return handler;
}

export async function markFailed(videoId, stage, err) {
  const video = await M().Video.findByPk(videoId);
  if (!video || video.cancelled) return;
  const patch = {
    status: VIDEO_STATUS.FAILED, current_stage: stage, error_stage: stage,
    error_code: String(err.code || "UNEXPECTED").replace(/^.*?:\s*/, "").slice(0, 64),
    error_message: String(err.message || err).replace(/^[A-Z_]+:\s*/, "").slice(0, 2000),
  };
  if (stage === STAGES.TRANSCRIBE) patch.transcript_status = TASK_STATUS.FAILED;
  if (stage === STAGES.ANALYZE) patch.analysis_status = TASK_STATUS.FAILED;
  if (stage === STAGES.GENERATE) patch.generation_status = GENERATION_STATUS.FAILED;
  await setVideo(video, patch);
  await logStage(video, stage, "FAILED", { error: err });
  await refreshBatch(video.batch_id);
}

// ---------------- stages ----------------

/** Reuse prior transcript + analysis for the same URL or content hash when providers/models are compatible. */
async function findReusable(video, { byHash = false } = {}) {
  const { Video, Transcript, ScreenplayAnalysis } = M();
  const where = { id: { [Op.ne]: video.id } };
  if (byHash) { if (!video.content_hash) return null; where.content_hash = video.content_hash; }
  else where.normalized_url = video.normalized_url;
  const candidates = await Video.findAll({ where, order: [["updated_at", "DESC"]], limit: 5 });
  const analyzer = providers.analyzer(), transcriber = providers.transcriber();
  for (const c of candidates) {
    const [t, a] = await Promise.all([latest(Transcript, c.id), latest(ScreenplayAnalysis, c.id)]);
    if (!t || !a) continue;
    const modelOk = a.model_metadata?.provider === analyzer.name && (analyzer.name === "mock" || a.model_metadata?.model === config.gemini.model);
    const txOk = t.provider_metadata?.provider === transcriber.name || t.provider_metadata?.provider === "none";
    if (modelOk && txOk) return { from: c, transcript: t, analysis: a };
  }
  return null;
}

async function applyReuse(video, reuse, reason) {
  const { Transcript, ScreenplayAnalysis } = M();
  await Transcript.create({
    video_id: video.id, raw_transcript: reuse.transcript.raw_transcript,
    normalized_transcript: { ...reuse.transcript.normalized_transcript, video_id: video.id },
    language: reuse.transcript.language, duration_seconds: reuse.transcript.duration_seconds,
    provider_metadata: { ...reuse.transcript.provider_metadata, reused_from: reuse.from.id, reuse_reason: reason },
  });
  await ScreenplayAnalysis.create({
    video_id: video.id, raw_analysis: reuse.analysis.raw_analysis, normalized_analysis: reuse.analysis.normalized_analysis,
    model_metadata: { ...reuse.analysis.model_metadata, reused_from: reuse.from.id, reuse_reason: reason },
  });
  await setVideo(video, { transcript_status: TASK_STATUS.DONE, analysis_status: TASK_STATUS.DONE, status: VIDEO_STATUS.MATCHING, current_stage: STAGES.MATCH });
  await enqueue(STAGES.MATCH, video.id);
}

const download = stageHandler(STAGES.DOWNLOAD, async (video) => {
  // Stage-level cache: a previous batch already analysed this URL with compatible providers.
  const reuse = await findReusable(video);
  if (reuse) { await applyReuse(video, reuse, "same_url"); return { reused_from: reuse.from.id, reason: "same_url" }; }
  if (video.video_path && existsSync(video.video_path)) { await enqueue(STAGES.AUDIO, video.id); return { skipped: "already_downloaded" }; }

  await setVideo(video, { status: VIDEO_STATUS.DOWNLOADING, current_stage: STAGES.DOWNLOAD, error_code: null, error_message: null });
  const r = await providers.downloader().download(video.normalized_url, { videoId: video.id });
  // Media retention counts from the download, so stamp the file now (downloaders/copies may keep the source's mtime).
  const now = new Date();
  await utimes(r.filePath, now, now).catch(() => {});
  const hash = await sha256File(r.filePath);
  await video.update({ video_path: r.filePath, has_audio: r.hasAudio, content_hash: hash, media_metadata: { ...video.media_metadata, download: { ...r.metadata, size_bytes: r.sizeBytes, duration_seconds: r.durationSeconds } } });

  const byHash = await findReusable(video, { byHash: true });
  if (byHash) { await applyReuse(video, byHash, "same_content"); return { reused_from: byHash.from.id, reason: "same_content", size_bytes: r.sizeBytes }; }
  await enqueue(STAGES.AUDIO, video.id);
  return { size_bytes: r.sizeBytes, duration_seconds: r.durationSeconds, provider: providers.downloader().name };
});

const audio = stageHandler(STAGES.AUDIO, async (video) => {
  if (!video.video_path || !existsSync(video.video_path)) {
    // Media expired (retention) — re-download only if analysis still needs the file.
    await setVideo(video, { video_path: null, status: VIDEO_STATUS.PENDING });
    await enqueue(STAGES.DOWNLOAD, video.id);
    return { redownload: true };
  }
  await setVideo(video, { status: VIDEO_STATUS.AUDIO_EXTRACTION, current_stage: STAGES.AUDIO });
  const r = await providers.audioExtractor().extract(video.video_path, { videoId: video.id });
  const patch = { audio_path: r.audioPath, has_audio: r.hasAudio, status: VIDEO_STATUS.ANALYSIS_PENDING, current_stage: "analysis" };
  if (!r.hasAudio) {
    // No audio track: nothing to transcribe. Persist an empty transcript so matching can report INCONCLUSIVE.
    const normalized = await new TranscriptNormalizer().normalize({ raw: { audio_duration: 0, utterances: [], words: [], language_code: "unknown" }, videoId: video.id });
    await M().Transcript.create({ video_id: video.id, raw_transcript: { note: "video has no audio track" }, normalized_transcript: normalized, language: null, duration_seconds: 0, provider_metadata: { provider: "none", reason: "no_audio" } });
    patch.transcript_status = TASK_STATUS.SKIPPED;
  }
  await setVideo(video, patch);
  // Transcription and screenplay analysis run concurrently.
  if (r.hasAudio && video.transcript_status !== TASK_STATUS.DONE) await enqueue(STAGES.TRANSCRIBE, video.id);
  if (video.analysis_status !== TASK_STATUS.DONE) await enqueue(STAGES.ANALYZE, video.id);
  else await join(video.id);
  return { has_audio: r.hasAudio, audio_seconds: r.durationSeconds, size_bytes: r.sizeBytes, elapsed_ms: r.elapsedMs };
});

const transcribe = stageHandler(STAGES.TRANSCRIBE, async (video) => {
  if (await latest(M().Transcript, video.id)) {
    await setVideo(video, { transcript_status: TASK_STATUS.DONE });
    await join(video.id);
    return { skipped: "transcript_exists" };
  }
  const imp = importedText(video);
  if (imp) {
    await setVideo(video, { transcript_status: TASK_STATUS.RUNNING, status: VIDEO_STATUS.TRANSCRIBING, current_stage: STAGES.TRANSCRIBE });
    const built = rawTranscriptFromText({ transcript: imp.transcript, screenplay: imp.screenplay, durationSeconds: imp.duration });
    const normalized = await new TranscriptNormalizer().normalize({ raw: built.raw, sentences: built.sentences, videoId: video.id });
    normalized.source = `imported_${built.source}`;
    const check = validate("transcript", normalized);
    if (!check.valid) throw permanent("TRANSCRIPT_INVALID", `Imported transcript failed validation: ${check.errors.slice(0, 3).join("; ")}`);
    await M().Transcript.create({
      video_id: video.id, raw_transcript: { imported: true, source: built.source, text: built.raw.text }, normalized_transcript: normalized,
      language: normalized.language, duration_seconds: normalized.duration_seconds, provider_metadata: { provider: "import", source: built.source, speakers: built.speakers },
    });
    await setVideo(video, { transcript_status: TASK_STATUS.DONE });
    await join(video.id);
    return { provider: "import", source: built.source, segments: normalized.dialogue_segments.length + normalized.narration_segments.length };
  }
  if (!video.audio_path || !existsSync(video.audio_path)) { await enqueue(STAGES.AUDIO, video.id); return { reextract: true }; }
  await setVideo(video, { transcript_status: TASK_STATUS.RUNNING, status: VIDEO_STATUS.TRANSCRIBING, current_stage: STAGES.TRANSCRIBE });
  const r = await providers.transcriber().transcribe(video.audio_path, { videoKey: video.normalized_url, videoId: video.id });
  const normalized = await new TranscriptNormalizer().normalize({ raw: r.raw, sentences: r.sentences, videoId: video.id });
  const check = validate("transcript", normalized);
  if (!check.valid) throw permanent("TRANSCRIPT_INVALID", `Normalized transcript failed validation: ${check.errors.slice(0, 3).join("; ")}`);
  await M().Transcript.create({
    video_id: video.id, raw_transcript: { ...r.raw, sentences: r.sentences ?? undefined }, normalized_transcript: normalized,
    language: normalized.language, duration_seconds: normalized.duration_seconds, provider_metadata: r.metadata,
  });
  await setVideo(video, { transcript_status: TASK_STATUS.DONE });
  await join(video.id);
  return { provider: r.metadata.provider, language: normalized.language, words: normalized.stats.word_count, usage: r.metadata.usage || null, latency_ms: r.metadata.latency_ms ?? null };
});

const analyze = stageHandler(STAGES.ANALYZE, async (video) => {
  if (await latest(M().ScreenplayAnalysis, video.id)) {
    await setVideo(video, { analysis_status: TASK_STATUS.DONE });
    await join(video.id);
    return { skipped: "analysis_exists" };
  }
  const imp = importedText(video);
  if (imp) {
    await setVideo(video, { analysis_status: TASK_STATUS.RUNNING, status: VIDEO_STATUS.SCREENPLAY_ANALYSIS, current_stage: STAGES.ANALYZE });
    const analyzer = providers.analyzer();
    if (typeof analyzer.analyzeScreenplayText !== "function") throw permanent("ANALYZER_NO_TEXT", `The "${analyzer.name}" analyzer cannot analyse screenplay text`);
    const r = await analyzer.analyzeScreenplayText(imp.screenplay, { videoId: video.id, videoKey: video.normalized_url, durationSeconds: imp.duration });
    const { analysis, repairs, evidence } = normalizeScreenplay(r.analysis, { durationSeconds: imp.duration });
    const check = validate("screenplay", analysis);
    if (!check.valid) throw permanent("ANALYSIS_INVALID", `Screenplay analysis failed validation after normalisation: ${check.errors.slice(0, 3).join("; ")}`);
    await M().ScreenplayAnalysis.create({ video_id: video.id, raw_analysis: r.raw, normalized_analysis: analysis, model_metadata: { ...r.metadata, repairs, evidence } });
    await setVideo(video, { analysis_status: TASK_STATUS.DONE });
    await join(video.id);
    return { provider: r.metadata.provider, model: r.metadata.model, source: "screenplay_text", attempts: r.metadata.attempts, usage: r.metadata.usage || null, repairs: repairs.length, scenes: evidence.scene_count };
  }
  if (!video.video_path || !existsSync(video.video_path)) { await enqueue(STAGES.DOWNLOAD, video.id); return { redownload: true }; }
  await setVideo(video, { analysis_status: TASK_STATUS.RUNNING, status: VIDEO_STATUS.SCREENPLAY_ANALYSIS, current_stage: STAGES.ANALYZE });
  const r = await providers.analyzer().analyzeVideo(video.video_path, { videoId: video.id, videoKey: video.normalized_url, durationSeconds: video.media_metadata?.download?.duration_seconds });
  const { analysis, repairs, evidence } = normalizeScreenplay(r.analysis, { durationSeconds: video.media_metadata?.download?.duration_seconds });
  const check = validate("screenplay", analysis);
  if (!check.valid) throw permanent("ANALYSIS_INVALID", `Screenplay analysis failed validation after normalisation: ${check.errors.slice(0, 3).join("; ")}`);
  await M().ScreenplayAnalysis.create({ video_id: video.id, raw_analysis: r.raw, normalized_analysis: analysis, model_metadata: { ...r.metadata, repairs, evidence } });
  await setVideo(video, { analysis_status: TASK_STATUS.DONE });
  await join(video.id);
  return { provider: r.metadata.provider, model: r.metadata.model, attempts: r.metadata.attempts, usage: r.metadata.usage || null, repairs: repairs.length, scenes: evidence.scene_count };
});

/** Join point: start matching once both concurrent tasks have finished (job-id dedupe prevents double enqueue). */
async function join(videoId) {
  const v = await M().Video.findByPk(videoId);
  if (!v || v.cancelled || v.status === VIDEO_STATUS.FAILED) return;
  const txReady = [TASK_STATUS.DONE, TASK_STATUS.SKIPPED].includes(v.transcript_status);
  if (txReady && v.analysis_status === TASK_STATUS.DONE) {
    await setVideo(v, { status: VIDEO_STATUS.MATCHING, current_stage: STAGES.MATCH });
    await enqueue(STAGES.MATCH, videoId);
  } else if (v.status !== VIDEO_STATUS.ANALYSIS_PENDING && (v.transcript_status === TASK_STATUS.DONE || v.analysis_status === TASK_STATUS.DONE)) {
    // One side finished; reflect the side still running.
    const running = v.analysis_status !== TASK_STATUS.DONE ? VIDEO_STATUS.SCREENPLAY_ANALYSIS : VIDEO_STATUS.TRANSCRIBING;
    await setVideo(v, { status: running });
  }
}

const match = stageHandler(STAGES.MATCH, async (video) => {
  const [t, a] = await Promise.all([latest(M().Transcript, video.id), latest(M().ScreenplayAnalysis, video.id)]);
  if (!t || !a) throw permanent("MATCH_INPUTS_MISSING", "Transcript or screenplay analysis is missing");
  await setVideo(video, { status: VIDEO_STATUS.MATCHING, current_stage: STAGES.MATCH });
  const settings = await getScoringSettings();
  const matcher = new MatchingService({ embeddings: providers.embeddings(), config: settings });
  const result = await matcher.compare({ transcript: t.normalized_transcript, screenplayAnalysis: a.normalized_analysis, videoId: video.id });
  await M().MatchResult.create({
    video_id: video.id, overall_score: result.overall_score, story_score: result.story_score, character_score: result.character_score,
    dialogue_score: result.dialogue_score, confidence: result.confidence, match_status: result.match_status, eligible: result.eligible,
    evidence: { ...result.evidence, inconclusive_reasons: result.inconclusive_reasons }, reasoning: result.reasoning,
    scoring_version: result.scoring_version, scoring_configuration: result.scoring_configuration,
  });

  const batch = await M().Batch.findByPk(video.batch_id, { attributes: ["purpose"] });
  if (batch?.purpose === BATCH_PURPOSE.DATASET) {
    // Training video: keep its structural abstraction for the dataset; no per-video script.
    const { storyDna, provenance } = new StoryDNABuilder().build({ analysis: a.normalized_analysis, transcript: t.normalized_transcript, matchResult: result });
    await M().StoryDNA.create({ video_id: video.id, story_dna: { ...storyDna, _provenance: provenance } });
    await setVideo(video, { status: VIDEO_STATUS.COMPLETED, current_stage: null, generation_status: GENERATION_STATUS.DATASET });
  } else if (result.eligible) {
    const { storyDna, provenance } = new StoryDNABuilder().build({ analysis: a.normalized_analysis, transcript: t.normalized_transcript, matchResult: result });
    await M().StoryDNA.create({ video_id: video.id, story_dna: { ...storyDna, _provenance: provenance } });
    await setVideo(video, { status: VIDEO_STATUS.GENERATION_PENDING, current_stage: STAGES.GENERATE, generation_status: GENERATION_STATUS.PENDING });
    await enqueue(STAGES.GENERATE, video.id);
  } else {
    await setVideo(video, {
      status: result.match_status === MATCH_STATUS.INCONCLUSIVE ? VIDEO_STATUS.INCONCLUSIVE : VIDEO_STATUS.SKIPPED_LOW_SCORE,
      current_stage: null, generation_status: GENERATION_STATUS.NOT_ELIGIBLE,
    });
  }
  if (config.storage.retentionHours === 0) await deleteMedia(video);
  const cache = providers.embeddings().stats;
  return { match_status: result.match_status, overall_score: result.overall_score, confidence: result.confidence, eligible: result.eligible, embedding: result.scoring_configuration.embedding.provider, embedding_cache: cache ? { ...cache } : null };
});

const generate = stageHandler(STAGES.GENERATE, async (video) => {
  const [m, dnaRow, t, a] = await Promise.all([latest(M().MatchResult, video.id), latest(M().StoryDNA, video.id), latest(M().Transcript, video.id), latest(M().ScreenplayAnalysis, video.id)]);
  if (!m?.eligible || !dnaRow) throw permanent("NOT_ELIGIBLE", "No approved match / Story DNA for this video");
  await setVideo(video, { status: VIDEO_STATUS.SCRIPT_GENERATION, current_stage: STAGES.GENERATE, generation_status: GENERATION_STATUS.RUNNING });
  const { _provenance, ...storyDNA } = dnaRow.story_dna;
  const svc = new ScriptGenerationService({ adapter: providers.skillAdapter(), embeddings: providers.embeddings() });
  const out = await svc.generate({
    storyDNA, screenplayAnalysis: a.normalized_analysis, transcriptSummary: summarizeTranscript(t.normalized_transcript),
    transcript: t.normalized_transcript, matchResult: { eligible: m.eligible, overall_score: m.overall_score }, videoId: video.id,
    generationOptions: {},
  });
  await M().GeneratedScript.create({
    video_id: video.id, script_content: out.content, generation_status: out.status,
    skill_identifier: out.metadata.skill_identifier || providers.skillAdapter().identifier, skill_version: out.metadata.skill_version ?? null,
    generation_metadata: { ...out.metadata, originality: out.originality },
  });
  await setVideo(video, { status: VIDEO_STATUS.COMPLETED, current_stage: null, generation_status: out.status });
  return { generation_status: out.status, skill: out.metadata.skill_identifier, cost_usd: out.metadata.total_cost_usd ?? null, originality_issues: out.originality?.issues?.length ?? null };
});

// ---------------- standalone scripts (Scripts tab) ----------------

function scriptEvent(s) {
  return { type: "script", script_id: s.id, status: s.status, title: s.title, error_message: s.error_message };
}

async function setScript(script, patch) {
  await script.update(patch);
  publish(scriptEvent(script));
  return script;
}

/** Queue one or more standalone episode scripts from a dataset. */
export async function createScripts({ datasetId, genre, subgenre, targetDurationSeconds, language, premise, notes, count = 1 }) {
  const { Script } = M();
  const dataset = datasetId ? await getDataset(datasetId) : await latestDataset();
  if (!dataset) throw badRequest("Build a dataset first (upload your best/bad training videos as a Training dataset batch).");
  if (!dataset.profile.genres.some(g => g.genre === genre)) throw badRequest(`Genre "${genre}" is not in the dataset`);
  const pb = playbookFor(dataset.profile, { genre, subgenre });
  const brief = {
    format: "Standalone episode for short-form vertical video",
    genre,
    subgenre: subgenre || null,
    target_duration_seconds: Math.round(targetDurationSeconds || pb.duration.target_seconds || 60),
    language: language || dominantLanguage(dataset.profile) || "hi",
    premise: premise?.trim() || null,
    notes: notes?.trim() || null,
  };
  const rows = [];
  for (let i = 0; i < count; i++) {
    const s = await Script.create({ dataset_id: dataset.id, brief: { ...brief, variant: count > 1 ? i + 1 : undefined }, status: SCRIPT_STATUS.QUEUED });
    await queues().add(STAGES.SCRIPT, { scriptId: s.id }, { jobId: jobIdFor(STAGES.SCRIPT, s.id) });
    publish(scriptEvent(s));
    rows.push(s);
  }
  return rows;
}

function dominantLanguage(profile) {
  return Object.entries(profile.overview.languages || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

const scriptHandler = async (job) => {
  const { Script } = M();
  const script = await Script.findByPk(job.data.scriptId);
  if (!script || [SCRIPT_STATUS.COMPLETED, SCRIPT_STATUS.REJECTED].includes(script.status)) return { skipped: true };
  // Claim it: only one worker (even across processes) moves a script from QUEUED to RUNNING and runs the agent.
  const [claimed] = await Script.update({ status: SCRIPT_STATUS.RUNNING, error_message: null }, { where: { id: script.id, status: SCRIPT_STATUS.QUEUED } });
  if (!claimed) return { skipped: "already running or finished elsewhere" };
  await script.reload();
  publish(scriptEvent(script));
  const dataset = script.dataset_id ? await getDataset(script.dataset_id) : await latestDataset();
  if (!dataset) throw permanent("NO_DATASET", "The dataset used for this script no longer exists");
  const { variant, ...brief } = script.brief;
  const playbook = playbookFor(dataset.profile, { genre: brief.genre, subgenre: brief.subgenre });
  if (variant) brief.variant_note = `This is variant ${variant}; make its premise clearly different from other variants.`;
  const svc = new ScriptGenerationService({ adapter: providers.skillAdapter(), embeddings: providers.embeddings() });
  const out = await svc.generateStandalone({ brief, playbook, corpus: await datasetCorpus(dataset), scriptId: script.id });
  await setScript(script, {
    status: out.status, content: out.content, title: out.title || script.title,
    skill_identifier: out.metadata.skill_identifier || providers.skillAdapter().identifier, skill_version: out.metadata.skill_version ?? null,
    generation_metadata: { ...out.metadata, playbook }, originality: out.originality,
  });
  return { status: out.status };
};
scriptHandler.onFinalFailure = async (job, err) => {
  const s = await M().Script.findByPk(job.data.scriptId);
  if (s) await setScript(s, { status: SCRIPT_STATUS.FAILED, error_message: String(err.message || err).replace(/^[A-Z_]+:\s*/, "").slice(0, 2000) });
};

export async function regenerateStandalone(scriptId) {
  const s = await M().Script.findByPk(scriptId);
  if (!s) throw notFound("Script");
  if ([SCRIPT_STATUS.QUEUED, SCRIPT_STATUS.RUNNING].includes(s.status)) throw conflict("This script is already being generated");
  await setScript(s, { status: SCRIPT_STATUS.QUEUED, error_message: null });
  await queues().add(STAGES.SCRIPT, { scriptId: s.id }, { jobId: jobIdFor(STAGES.SCRIPT, s.id) });
  return s;
}

/** Manual skill workflow for standalone scripts. */
export async function importStandalone(scriptId, content) {
  const s = await M().Script.findByPk(scriptId);
  if (!s) throw notFound("Script");
  const dataset = s.dataset_id ? await getDataset(s.dataset_id) : await latestDataset();
  const svc = new ScriptGenerationService({ adapter: providers.skillAdapter(), embeddings: providers.embeddings() });
  const out = await svc.finalizeStandalone(content, { corpus: dataset ? await datasetCorpus(dataset) : {}, metadata: { adapter: "manual-import" }, language: s.brief?.language });
  return setScript(s, { status: out.status, content: out.content, title: out.title || s.title, generation_metadata: { ...s.generation_metadata, ...out.metadata }, originality: out.originality, error_message: null });
}

export const handlers = { [STAGES.DOWNLOAD]: download, [STAGES.AUDIO]: audio, [STAGES.TRANSCRIBE]: transcribe, [STAGES.ANALYZE]: analyze, [STAGES.MATCH]: match, [STAGES.GENERATE]: generate, [STAGES.SCRIPT]: scriptHandler };

// ---------------- batch-level operations ----------------

export async function refreshBatch(batchId) {
  const { Batch, Video } = M();
  const batch = await Batch.findByPk(batchId);
  if (!batch) return null;
  const rows = await Video.findAll({ where: { batch_id: batchId }, attributes: ["status", [db().sequelize.fn("COUNT", "*"), "n"]], group: ["status"], raw: true });
  const counts = Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const terminal = TERMINAL_STATUSES.reduce((t, s) => t + (counts[s] || 0), 0);
  const patch = {
    total_videos: total,
    completed_videos: counts.COMPLETED || 0,
    failed_videos: counts.FAILED || 0,
    skipped_videos: (counts.SKIPPED_LOW_SCORE || 0) + (counts.INCONCLUSIVE || 0) + (counts.CANCELLED || 0),
  };
  const finishing = batch.status === BATCH_STATUS.PROCESSING && total > 0 && terminal === total;
  if (finishing) { patch.status = BATCH_STATUS.COMPLETED; patch.finished_at = new Date(); }
  await batch.update(patch);
  // Training batches are not built into the dataset automatically: the user reviews the analysed sheet
  // (GET /api/batches/:id/analysis) and then builds the dataset (POST /api/datasets).
  publish({ type: "batch", batch_id: batchId, status: batch.status, counts, total, terminal, progress: total ? terminal / total : 0 });
  return batch;
}

export async function startBatch(batchId) {
  const { Batch, Video } = M();
  const batch = await Batch.findByPk(batchId);
  if (!batch) throw notFound("Batch");
  if (![BATCH_STATUS.DRAFT, BATCH_STATUS.PROCESSING].includes(batch.status)) throw conflict(`Batch is ${batch.status.toLowerCase()} and cannot be started`);
  const pending = await Video.findAll({ where: { batch_id: batchId, status: VIDEO_STATUS.PENDING, cancelled: false } });
  if (!pending.length && batch.status === BATCH_STATUS.DRAFT) throw badRequest("Batch has no valid videos to process");
  await batch.update({ status: BATCH_STATUS.PROCESSING, started_at: batch.started_at || new Date(), settings_snapshot: await getScoringSettings() });
  let queued = 0;
  for (const v of pending) {
    if (importedText(v)) {
      await setVideo(v, { status: VIDEO_STATUS.ANALYSIS_PENDING, current_stage: "analysis" });
      for (const s of [STAGES.TRANSCRIBE, STAGES.ANALYZE]) { const r = await enqueue(s, v.id); if (!r.duplicate) queued++; }
      continue;
    }
    const r = await enqueue(STAGES.DOWNLOAD, v.id); if (!r.duplicate) queued++;
  }
  await refreshBatch(batchId);
  return { queued, total: pending.length };
}

/** Statuses in which a batch may be deleted (a running batch must be cancelled first). */
const DELETABLE = [BATCH_STATUS.DRAFT, BATCH_STATUS.COMPLETED, BATCH_STATUS.CANCELLED];

/**
 * Delete a batch and everything derived from its videos (transcripts, analyses, matches, Story DNA, per-video
 * scripts, logs) via the foreign-key cascade, plus their media files and any queued jobs.
 * Kept on purpose: dataset snapshots (their numbers were computed already) and the API usage ledger (money spent).
 */
export async function deleteBatch(batchId) {
  const { Batch, Video } = M();
  const batch = await Batch.findByPk(batchId);
  if (!batch) throw notFound("Batch");
  if (!DELETABLE.includes(batch.status)) throw conflict(`This batch is ${batch.status.toLowerCase()} — cancel it before deleting it`);
  const videos = await Video.findAll({ where: { batch_id: batchId }, attributes: ["id", "video_path", "audio_path"] });
  for (const v of videos) {
    await queues().removeForVideo(v.id).catch(() => 0);
    if (v.video_path || v.audio_path) await deleteMedia(v).catch(() => {});
  }
  await batch.destroy(); // ON DELETE CASCADE removes videos and all per-video rows
  publish({ type: "batch", batch_id: batchId, deleted: true });
  return { deleted: true, batch_id: batchId, filename: batch.filename, videos: videos.length };
}

/** Delete every cancelled batch. */
export async function deleteCancelledBatches() {
  const batches = await M().Batch.findAll({ where: { status: BATCH_STATUS.CANCELLED }, attributes: ["id"] });
  const results = [];
  for (const b of batches) results.push(await deleteBatch(b.id));
  return { deleted: results.length, videos: results.reduce((t, r) => t + r.videos, 0), batches: results };
}

export async function cancelBatch(batchId) {
  const { Batch, Video } = M();
  const batch = await Batch.findByPk(batchId);
  if (!batch) throw notFound("Batch");
  const active = await Video.findAll({ where: { batch_id: batchId, status: { [Op.notIn]: TERMINAL_STATUSES } } });
  // Mark everything cancelled first (one statement), so jobs that start meanwhile skip immediately…
  await Video.update({ cancelled: true, status: VIDEO_STATUS.CANCELLED, current_stage: null }, { where: { id: active.map(v => v.id) } });
  // …then drop queued jobs. Running jobs stop cooperatively at their next stage boundary.
  let removed = 0;
  for (const v of active) {
    removed += await queues().removeForVideo(v.id);
    await v.reload();
    publish(videoEvent(v));
    await logStage(v, "batch", "CANCELLED");
  }
  await batch.update({ status: BATCH_STATUS.CANCELLED, finished_at: new Date() });
  await refreshBatch(batchId);
  return { cancelled: active.length, removed_jobs: removed };
}

/** Work out where a video should resume from, using only persisted state. */
export async function resumeStages(video) {
  const { Transcript, ScreenplayAnalysis, MatchResult, StoryDNA } = M();
  const [t, a, m, dna] = await Promise.all([latest(Transcript, video.id), latest(ScreenplayAnalysis, video.id), latest(MatchResult, video.id), latest(StoryDNA, video.id)]);
  if (m?.eligible && dna) return [STAGES.GENERATE];
  if (t && a) return [STAGES.MATCH];
  if (importedText(video)) return [!t && STAGES.TRANSCRIBE, !a && STAGES.ANALYZE].filter(Boolean);
  const haveVideo = video.video_path && existsSync(video.video_path);
  const haveAudio = video.audio_path && existsSync(video.audio_path);
  if (!haveVideo && !a) return [STAGES.DOWNLOAD];
  const stages = [];
  if (!t) { if (haveAudio) stages.push(STAGES.TRANSCRIBE); else if (haveVideo) return [STAGES.AUDIO]; else return [STAGES.DOWNLOAD]; }
  if (!a) stages.push(haveVideo ? STAGES.ANALYZE : STAGES.DOWNLOAD);
  return [...new Set(stages)];
}

const STAGE_STATUS = {
  [STAGES.DOWNLOAD]: VIDEO_STATUS.PENDING, [STAGES.AUDIO]: VIDEO_STATUS.AUDIO_EXTRACTION, [STAGES.TRANSCRIBE]: VIDEO_STATUS.ANALYSIS_PENDING,
  [STAGES.ANALYZE]: VIDEO_STATUS.ANALYSIS_PENDING, [STAGES.MATCH]: VIDEO_STATUS.MATCHING, [STAGES.GENERATE]: VIDEO_STATUS.GENERATION_PENDING,
};

/** Manual retry from the failed stage — completed stages are not repeated. */
export async function retryVideo(videoId) {
  const { Video, Batch } = M();
  const video = await Video.findByPk(videoId);
  if (!video) throw notFound("Video");
  if (![VIDEO_STATUS.FAILED, VIDEO_STATUS.CANCELLED, VIDEO_STATUS.INCONCLUSIVE, VIDEO_STATUS.SKIPPED_LOW_SCORE].includes(video.status))
    throw conflict(`Video is ${video.status} — only failed, cancelled, inconclusive or skipped videos can be retried`);
  const stages = await resumeStages(video);
  const patch = { cancelled: false, error_code: null, error_message: null, error_stage: null, status: STAGE_STATUS[stages[0]], current_stage: stages[0] };
  if (video.transcript_status === TASK_STATUS.FAILED) patch.transcript_status = TASK_STATUS.PENDING;
  if (video.analysis_status === TASK_STATUS.FAILED) patch.analysis_status = TASK_STATUS.PENDING;
  if (stages.includes(STAGES.GENERATE)) patch.generation_status = GENERATION_STATUS.PENDING;
  await setVideo(video, patch);
  const batch = await Batch.findByPk(video.batch_id);
  if (batch && batch.status !== BATCH_STATUS.PROCESSING) await batch.update({ status: BATCH_STATUS.PROCESSING, finished_at: null });
  for (const s of stages) await enqueue(s, video.id);
  await logStage(video, "retry", "QUEUED", { metadata: { stages } });
  await refreshBatch(video.batch_id);
  return { stages };
}

/** Re-run only script generation from stored Story DNA + approved analysis. */
export async function regenerateScript(videoId) {
  const { Video, MatchResult, StoryDNA, Batch } = M();
  const video = await Video.findByPk(videoId);
  if (!video) throw notFound("Video");
  const [m, dna] = await Promise.all([latest(MatchResult, videoId), latest(StoryDNA, videoId)]);
  if (!m?.eligible || !dna) throw conflict("This video has no approved match / Story DNA, so a script cannot be generated");
  if ([VIDEO_STATUS.SCRIPT_GENERATION, VIDEO_STATUS.GENERATION_PENDING].includes(video.status)) throw conflict("Generation is already in progress");
  await setVideo(video, { status: VIDEO_STATUS.GENERATION_PENDING, current_stage: STAGES.GENERATE, generation_status: GENERATION_STATUS.PENDING, cancelled: false, error_code: null, error_message: null });
  const batch = await Batch.findByPk(video.batch_id);
  if (batch && batch.status !== BATCH_STATUS.PROCESSING) await batch.update({ status: BATCH_STATUS.PROCESSING, finished_at: null });
  await enqueue(STAGES.GENERATE, videoId);
  await refreshBatch(video.batch_id);
  return { queued: true };
}

/** Manual skill workflow: import a script produced outside the app; validated like any other output. */
export async function importScript(videoId, content, { skillIdentifier, skillVersion } = {}) {
  const { Video, MatchResult, StoryDNA, Transcript, ScreenplayAnalysis, GeneratedScript } = M();
  const video = await Video.findByPk(videoId);
  if (!video) throw notFound("Video");
  const [m, dnaRow, t, a] = await Promise.all([latest(MatchResult, videoId), latest(StoryDNA, videoId), latest(Transcript, videoId), latest(ScreenplayAnalysis, videoId)]);
  if (!m?.eligible || !dnaRow) throw conflict("Scripts can only be imported for videos with an approved match");
  const { _provenance, ...storyDNA } = dnaRow.story_dna;
  const svc = new ScriptGenerationService({ adapter: providers.skillAdapter(), embeddings: providers.embeddings() });
  const out = await svc.finalize(content, { metadata: { adapter: "manual-import" }, transcript: t?.normalized_transcript, screenplayAnalysis: a?.normalized_analysis, storyDNA });
  const row = await GeneratedScript.create({
    video_id: videoId, script_content: out.content, generation_status: out.status,
    skill_identifier: skillIdentifier || providers.skillAdapter().identifier, skill_version: skillVersion || null,
    generation_metadata: { ...out.metadata, originality: out.originality },
  });
  await setVideo(video, { status: VIDEO_STATUS.COMPLETED, current_stage: null, generation_status: out.status }, { force: true });
  await logStage(video, STAGES.GENERATE, "IMPORTED", { metadata: { generation_status: out.status } });
  await refreshBatch(video.batch_id);
  return row;
}

/** After a worker restart: re-enqueue unfinished videos from their persisted stage (job ids dedupe live jobs). */
export async function recoverInFlight() {
  const { Batch, Video } = M();
  const batches = await Batch.findAll({ where: { status: BATCH_STATUS.PROCESSING } });
  let requeued = 0;
  for (const b of batches) {
    const videos = await Video.findAll({ where: { batch_id: b.id, cancelled: false, status: { [Op.notIn]: TERMINAL_STATUSES } } });
    for (const v of videos) {
      const stages = v.status === VIDEO_STATUS.PENDING ? [STAGES.DOWNLOAD] : await resumeStages(v);
      for (const s of stages) { const r = await enqueue(s, v.id); if (!r.duplicate) requeued++; }
    }
    await refreshBatch(b.id);
  }
  // Standalone scripts: a restart kills an in-memory job (and the agent it started), leaving the script
  // QUEUED/RUNNING with nothing behind it. Requeue them; the job id dedupe skips any still in a durable queue.
  const { Script } = M();
  const stuck = await Script.findAll({ where: { status: [SCRIPT_STATUS.QUEUED, SCRIPT_STATUS.RUNNING] } });
  for (const s of stuck) {
    await setScript(s, { status: SCRIPT_STATUS.QUEUED, error_message: null });
    const r = await queues().add(STAGES.SCRIPT, { scriptId: s.id }, { jobId: jobIdFor(STAGES.SCRIPT, s.id) });
    if (!r?.duplicate) requeued++;
  }
  if (requeued) logger.info({ requeued, scripts: stuck.length }, "recovered in-flight videos and scripts");
  return requeued;
}

// ---------------- media retention ----------------

async function deleteMedia(video) {
  for (const p of [video.video_path, video.audio_path]) if (p) await rm(p, { force: true }).catch(() => {});
  if (video.video_path) await rm(video.video_path.replace(/[\\/][^\\/]+$/, ""), { recursive: true, force: true }).catch(() => {});
  await video.update({ video_path: null, audio_path: null });
}

/** Delete downloaded media older than MEDIA_RETENTION_HOURS (only for videos past the analysis stages). */
export async function sweepMedia({ now = Date.now(), retentionHours = config.storage.retentionHours } = {}) {
  const { Video } = M();
  const videos = await Video.findAll({ where: { [Op.or]: [{ video_path: { [Op.ne]: null } }, { audio_path: { [Op.ne]: null } }] } });
  let deleted = 0;
  for (const v of videos) {
    const inUse = [VIDEO_STATUS.DOWNLOADING, VIDEO_STATUS.AUDIO_EXTRACTION, VIDEO_STATUS.ANALYSIS_PENDING, VIDEO_STATUS.TRANSCRIBING, VIDEO_STATUS.SCREENPLAY_ANALYSIS].includes(v.status);
    if (inUse) continue;
    const p = v.video_path || v.audio_path;
    const mtime = await stat(p).then(s => s.mtimeMs).catch(() => 0);
    if (!mtime || now - mtime >= retentionHours * 3600_000) { await deleteMedia(v); deleted++; }
  }
  return deleted;
}
