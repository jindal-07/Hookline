// Builds provider instances from configuration. Tests replace them with setProviders().
import path from "node:path";
import { config } from "../config/env.js";
import { db } from "../models/index.js";
import { YtDlpDownloader, MockDownloader, UnavailableDownloader } from "./video/VideoDownloader.js";
import { AudioExtractor } from "./audio/AudioExtractor.js";
import { AssemblyAITranscriber, MockTranscriber } from "./transcription/AssemblyAITranscriber.js";
import { GeminiVideoAnalyzer, MockVideoAnalyzer } from "./screenplay/GeminiVideoAnalyzer.js";
import { GeminiEmbeddingService, LocalEmbeddingService, HashEmbeddingService } from "./embeddings/providers.js";
import { CachedEmbeddingService } from "./embeddings/CachedEmbeddingService.js";
import { AgentSdkSkillAdapter, ManualSkillAdapter, DisabledSkillAdapter, MockSkillAdapter } from "./generation/skillAdapters.js";
import { permanent } from "../utils/errors.js";

let overrides = {};
const cache = {};

/** Replace providers (tests / alternative deployments). Pass {} to reset. */
export function setProviders(p) {
  overrides = p || {};
  for (const k of Object.keys(cache)) delete cache[k];
}

/** Lazily build each provider; construction errors (missing keys) surface when the stage runs, not at boot. */
function lazy(key, build) {
  if (overrides[key]) return overrides[key];
  if (!cache[key]) cache[key] = build();
  return cache[key];
}

export const providers = {
  downloader: () => lazy("downloader", () => {
    const common = { outputDir: config.storage.videoDir, maxSizeBytes: config.limits.maxVideoSizeBytes, maxDurationSeconds: config.limits.maxVideoDurationSeconds };
    if (config.providers.downloader === "mock") return new MockDownloader({ ...common, defaultFixture: process.env.MOCK_VIDEO_FIXTURE || null });
    if (config.providers.downloader === "none") return new UnavailableDownloader();
    return new YtDlpDownloader({ ...common, ytdlpPath: config.downloader.ytdlpPath, cookiesFile: config.downloader.cookiesFile, allowedHosts: config.downloader.allowedHosts, timeoutMs: config.timeouts.download });
  }),
  audioExtractor: () => lazy("audioExtractor", () => new AudioExtractor({ outputDir: config.storage.audioDir, timeoutMs: config.timeouts.audio })),
  transcriber: () => lazy("transcriber", () => {
    if (config.providers.transcriber === "mock") return new MockTranscriber();
    if (!config.assemblyai.apiKey) return missing("ASSEMBLYAI_API_KEY", "transcribe");
    return new AssemblyAITranscriber({ apiKey: config.assemblyai.apiKey, speechModels: config.assemblyai.speechModels, expectedLanguages: config.assemblyai.expectedLanguages, timeoutMs: config.timeouts.transcribe });
  }),
  analyzer: () => lazy("analyzer", () => {
    if (config.providers.analyzer === "mock") return new MockVideoAnalyzer();
    if (!config.gemini.apiKey) return missing("GEMINI_API_KEY", "analyzeVideo");
    return new GeminiVideoAnalyzer({ apiKey: config.gemini.apiKey, model: config.gemini.model, maxSinglePassSeconds: config.gemini.maxSinglePassSeconds, chunkSeconds: config.gemini.chunkSeconds, timeoutMs: config.timeouts.analyze, workDir: config.storage.videoDir });
  }),
  embeddings: () => lazy("embeddings", () => {
    const p = config.providers.embedding;
    const inner = p === "gemini" ? new GeminiEmbeddingService({ apiKey: config.embedding.apiKey, model: config.embedding.model || undefined, calibration: config.embedding.calibration })
      : p === "local" ? new LocalEmbeddingService({ model: config.embedding.model || undefined, calibration: config.embedding.calibration })
      : new HashEmbeddingService({ calibration: config.embedding.calibration });
    let model = null;
    try { model = db().models.EmbeddingCache; } catch { /* no DB (unit use) */ }
    return new CachedEmbeddingService({ inner, model });
  }),
  skillAdapter: () => lazy("skillAdapter", () => {
    const s = config.skill;
    if (s.mode === "agent-sdk") return new AgentSdkSkillAdapter({ skillDir: s.dir, skillName: s.name, workspaceDir: path.join(s.exchangeDir, "agent-workspace"), model: s.model || undefined, maxTurns: s.maxTurns, timeoutMs: config.timeouts.generate, apiKey: s.anthropicApiKey || undefined });
    if (s.mode === "manual") return new ManualSkillAdapter({ exchangeDir: s.exchangeDir, skillName: s.name, skillDir: s.dir });
    if (s.mode === "mock") return new MockSkillAdapter();
    return new DisabledSkillAdapter();
  }),
};

/** A provider stand-in that fails permanently with a clear configuration message. */
function missing(envVar, method) {
  return { name: "unconfigured", [method]: async () => { throw permanent("PROVIDER_NOT_CONFIGURED", `${envVar} is not configured`); } };
}
