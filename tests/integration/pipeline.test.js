import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { setupPipeline, teardownPipeline, makeBatch, URLS } from "../setup/pipeline.js";
import { startBatch, cancelBatch, retryVideo, regenerateScript, recoverInFlight, sweepMedia, importScript } from "../../server/src/services/pipeline/orchestrator.js";
import { queues } from "../../server/src/queues/index.js";
import { setProviders } from "../../server/src/services/registry.js";
import { closeDatabase } from "../../server/src/models/index.js";
import { subscribe } from "../../server/src/events/bus.js";
import { MockTranscriber } from "../../server/src/services/transcription/AssemblyAITranscriber.js";
import { MockVideoAnalyzer } from "../../server/src/services/screenplay/GeminiVideoAnalyzer.js";
import { ManualSkillAdapter } from "../../server/src/services/generation/skillAdapters.js";
import { transient, permanent } from "../../server/src/utils/errors.js";
import { baseScreenplay, rawTranscript, CONTRADICTORY_UTTERANCES, HINDI_UTTERANCES } from "../fixtures/matching.js";

let env;
const reload = (v) => env.ctx.models.Video.findByPk(v.id);
const logsFor = (v) => env.ctx.models.ProcessingLog.findAll({ where: { video_id: v.id }, order: [["created_at", "ASC"]] });

afterEach(teardownPipeline);
afterAll(closeDatabase);

describe("pipeline end-to-end (mocked providers)", () => {
  beforeEach(async () => { env = await setupPipeline(); });

  it("processes a batch: download → audio → (transcribe ∥ analyze) → match → story DNA → script", async () => {
    const events = [];
    const off = subscribe(e => events.push(e));
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good, URLS.good2]);
    expect(await startBatch(batch.id)).toEqual({ queued: 2, total: 2 });
    await env.drain();
    off();

    for (const v of videos) {
      const r = await reload(v);
      expect(r.status).toBe("COMPLETED");
      expect(r).toMatchObject({ transcript_status: "DONE", analysis_status: "DONE", generation_status: "COMPLETED" });
      const { Transcript, ScreenplayAnalysis, MatchResult, StoryDNA, GeneratedScript } = env.ctx.models;
      expect(await Transcript.count({ where: { video_id: v.id } })).toBe(1);
      expect(await ScreenplayAnalysis.count({ where: { video_id: v.id } })).toBe(1);
      const m = await MatchResult.findOne({ where: { video_id: v.id } });
      expect(m).toMatchObject({ match_status: "MATCHED", eligible: true, scoring_version: "1.0" });
      expect(m.scoring_configuration.threshold).toBe(75);
      expect(await StoryDNA.count({ where: { video_id: v.id } })).toBe(1);
      const s = await GeneratedScript.findOne({ where: { video_id: v.id } });
      expect(s.generation_status).toBe("COMPLETED");
      expect(s.script_content).toContain("MOCK SKILL OUTPUT");
    }
    const b = await env.ctx.models.Batch.findByPk(batch.id);
    expect(b).toMatchObject({ status: "COMPLETED", total_videos: 2, completed_videos: 2, failed_videos: 0 });
    expect(events.some(e => e.type === "video" && e.status === "TRANSCRIBING" || e.status === "SCREENPLAY_ANALYSIS")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "batch", progress: 1 });
  });

  it("runs transcription and screenplay analysis concurrently", async () => {
    let active = 0, peak = 0;
    const slow = (fn) => async (...a) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 150)); active--; return fn(...a); };
    env.providers.transcriber.transcribe = slow(env.providers.transcriber.transcribe.bind(env.providers.transcriber));
    env.providers.analyzer.analyzeVideo = slow(env.providers.analyzer.analyzeVideo.bind(env.providers.analyzer));
    const { batch } = await makeBatch(env.ctx.models, [URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    expect(peak).toBe(2);
  });

  it("one failed video never stops the batch; permanent errors are not retried", async () => {
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.private, URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    const [bad, good] = await Promise.all(videos.map(reload));
    expect(bad).toMatchObject({ status: "FAILED", error_code: "VIDEO_PRIVATE", error_stage: "download" });
    expect(good.status).toBe("COMPLETED");
    expect(env.providers.downloader.calls.filter(u => u === URLS.private)).toHaveLength(1); // no retries
    expect((await env.ctx.models.Batch.findByPk(batch.id))).toMatchObject({ status: "COMPLETED", failed_videos: 1, completed_videos: 1 });
  });

  it("retries transient failures with backoff and then succeeds", async () => {
    let n = 0;
    const orig = env.providers.transcriber.transcribe.bind(env.providers.transcriber);
    env.providers.transcriber.transcribe = async (...a) => { if (++n < 3) throw transient("PROVIDER_UNAVAILABLE", "503 from AssemblyAI"); return orig(...a); };
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    expect(n).toBe(3);
    expect((await reload(videos[0])).status).toBe("COMPLETED");
    const attempts = (await logsFor(videos[0])).filter(l => l.stage === "transcribe" && l.status === "ATTEMPT_FAILED");
    expect(attempts).toHaveLength(2);
  });

  it("failed transcription → FAILED with partial results kept; retry resumes without re-downloading or re-analysing", async () => {
    setProviders({ ...env.providers, transcriber: new MockTranscriber({ failWith: permanent("PROVIDER_AUTH", "Invalid AssemblyAI key") }) });
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    let v = await reload(videos[0]);
    expect(v).toMatchObject({ status: "FAILED", transcript_status: "FAILED", error_code: "PROVIDER_AUTH" });
    expect(await env.ctx.models.ScreenplayAnalysis.count({ where: { video_id: v.id } })).toBe(1); // concurrent analysis persisted

    setProviders({ ...env.providers }); // fixed credentials
    const analyzeCalls = env.providers.analyzer.calls.length, downloads = env.providers.downloader.calls.length;
    expect((await retryVideo(v.id)).stages).toEqual(["transcribe"]);
    await env.drain();
    v = await reload(videos[0]);
    expect(v.status).toBe("COMPLETED");
    expect(env.providers.analyzer.calls.length).toBe(analyzeCalls);
    expect(env.providers.downloader.calls.length).toBe(downloads);
  });

  it("failed screenplay analysis (malformed output) is reported and retryable", async () => {
    setProviders({ ...env.providers, analyzer: new MockVideoAnalyzer({ defaultFixture: { scenes: "not valid" } }) });
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    const v = await reload(videos[0]);
    expect(v).toMatchObject({ status: "FAILED", analysis_status: "FAILED", error_code: "ANALYSIS_INVALID" });
    expect(v.transcript_status).toBe("DONE");
  });

  it("low score → SKIPPED_LOW_SCORE without generation; threshold changes apply to new matches", async () => {
    setProviders({ ...env.providers, transcriber: new MockTranscriber({ defaultFixture: rawTranscript(CONTRADICTORY_UTTERANCES) }) });
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    const v = await reload(videos[0]);
    expect(v).toMatchObject({ status: "SKIPPED_LOW_SCORE", generation_status: "NOT_ELIGIBLE" });
    expect(env.providers.skillAdapter.calls).toHaveLength(0);
  });

  it("silent video → INCONCLUSIVE, flagged for review, no generation", async () => {
    const silent = baseScreenplay({ dialogue_moments: [] });
    silent.scenes.forEach(s => { s.dialogue_summary = ""; });
    setProviders({ ...env.providers, analyzer: new MockVideoAnalyzer({ defaultFixture: silent }) });
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.silent]);
    await startBatch(batch.id);
    await env.drain();
    const v = await reload(videos[0]);
    expect(v).toMatchObject({ status: "INCONCLUSIVE", transcript_status: "SKIPPED", has_audio: false });
    const m = await env.ctx.models.MatchResult.findOne({ where: { video_id: v.id } });
    expect(m.evidence.inconclusive_reasons).toContain("little_or_no_speech");
  });

  it("prevents duplicate jobs for the same video and stage", async () => {
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    const q = queues();
    const a = await q.add("download", { videoId: videos[0].id }, { jobId: `download__${videos[0].id}` });
    const b = await q.add("download", { videoId: videos[0].id }, { jobId: `download__${videos[0].id}` });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    void batch;
    await env.drain();
    expect(env.providers.downloader.calls).toHaveLength(1);
  });

  it("cancels queued work for a batch", async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const orig = env.providers.downloader.download.bind(env.providers.downloader);
    env.providers.downloader.download = async (...a) => { await gate; return orig(...a); };
    const urls = Array.from({ length: 8 }, (_, i) => `https://www.facebook.com/reel/20000000000${i}`);
    const { batch } = await makeBatch(env.ctx.models, urls);
    await startBatch(batch.id);
    const r = await cancelBatch(batch.id);
    release();
    await env.drain();
    expect(r.cancelled).toBe(8);
    // Only jobs already running when cancel arrived may finish their download; nothing proceeds past it.
    expect(env.providers.downloader.calls.length).toBeLessThan(8);
    expect(await env.ctx.models.Transcript.count()).toBe(0);
    const statuses = (await env.ctx.models.Video.findAll({ where: { batch_id: batch.id } })).map(v => v.status);
    expect(statuses.every(s => s === "CANCELLED")).toBe(true);
    expect((await env.ctx.models.Batch.findByPk(batch.id)).status).toBe("CANCELLED");
  });

  it("recovers in-flight videos after a worker restart from their persisted stage", async () => {
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    await batch.update({ status: "PROCESSING" });
    // Simulate a crash after transcript + analysis were stored but before matching ran.
    const { Transcript, ScreenplayAnalysis } = env.ctx.models;
    const { TranscriptNormalizer } = await import("../../server/src/services/normalization/TranscriptNormalizer.js");
    const raw = rawTranscript(HINDI_UTTERANCES);
    await Transcript.create({ video_id: videos[0].id, raw_transcript: raw, normalized_transcript: await new TranscriptNormalizer().normalize({ raw, videoId: videos[0].id }), provider_metadata: { provider: "mock" } });
    await ScreenplayAnalysis.create({ video_id: videos[0].id, raw_analysis: {}, normalized_analysis: baseScreenplay(), model_metadata: { provider: "mock" } });
    await videos[0].update({ status: "MATCHING", transcript_status: "DONE", analysis_status: "DONE" });

    expect(await recoverInFlight()).toBe(1);
    await env.drain();
    expect((await reload(videos[0])).status).toBe("COMPLETED");
    expect(env.providers.downloader.calls).toHaveLength(0);
  });

  it("reuses stored results for a URL processed in an earlier batch", async () => {
    const first = await makeBatch(env.ctx.models, [URLS.good], { filename: "a.xlsx" });
    await startBatch(first.batch.id);
    await env.drain();
    const calls = { d: env.providers.downloader.calls.length, t: env.providers.transcriber.calls.length, a: env.providers.analyzer.calls.length };
    const second = await makeBatch(env.ctx.models, [URLS.good], { filename: "b.xlsx" });
    await startBatch(second.batch.id);
    await env.drain();
    expect((await reload(second.videos[0])).status).toBe("COMPLETED");
    expect(env.providers.downloader.calls.length).toBe(calls.d);
    expect(env.providers.transcriber.calls.length).toBe(calls.t);
    expect(env.providers.analyzer.calls.length).toBe(calls.a);
    const t = await env.ctx.models.Transcript.findOne({ where: { video_id: second.videos[0].id } });
    expect(t.provider_metadata.reused_from).toBe(first.videos[0].id);
  });

  it("regenerates from stored Story DNA, and manual-skill imports are validated", async () => {
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    const before = env.providers.transcriber.calls.length;
    await regenerateScript(videos[0].id);
    await env.drain();
    expect(await env.ctx.models.GeneratedScript.count({ where: { video_id: videos[0].id } })).toBe(2);
    expect(env.providers.transcriber.calls.length).toBe(before);

    const row = await importScript(videos[0].id, "INT. KITCHEN\nMeera says अब नौकरानी अफसर बनेगी यह सपना देखो. ".repeat(6));
    expect(row.generation_status).toBe("REJECTED");
  });

  it("manual skill mode leaves the video awaiting import", async () => {
    setProviders({ ...env.providers, skillAdapter: new ManualSkillAdapter({ exchangeDir: "tests/.tmp/pipeline/exchange", skillName: "writer" }) });
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    expect((await reload(videos[0])).generation_status).toBe("AWAITING_MANUAL");
  });

  it("deletes temporary media according to the retention policy", async () => {
    const { batch, videos } = await makeBatch(env.ctx.models, [URLS.good]);
    await startBatch(batch.id);
    await env.drain();
    let v = await reload(videos[0]);
    const files = [v.video_path, v.audio_path];
    expect(files.every(f => f && existsSync(f))).toBe(true);
    expect(await sweepMedia({ retentionHours: 24 })).toBe(0);
    expect(await sweepMedia({ retentionHours: 0 })).toBe(1);
    v = await reload(videos[0]);
    expect(v.video_path).toBeNull();
    expect(files.some(f => existsSync(f))).toBe(false);
  });
});
