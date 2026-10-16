// Loads and validates environment configuration once at startup.
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import { DEFAULT_SCORING } from "@reelscript/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "../../..");
export const SERVER_DIR = path.resolve(here, "../..");
export const DEFAULT_SKILL_DIR = path.resolve(ROOT_DIR, "..", "scriptwriter-skill-1.0.0");

dotenv.config({ path: path.join(ROOT_DIR, ".env"), quiet: true });

const num = (def) => z.coerce.number().finite().default(def);
const optNum = () => z.preprocess(v => (v === "" || v == null ? undefined : v), z.coerce.number().positive().optional());
const str = (def = "") => z.string().default(def);
/** true / false, or undefined when unset ("decide automatically"). */
const optBool = () => z.preprocess(v => (v === undefined || v === "" ? undefined : ["1", "true", "yes", "on"].includes(String(v).toLowerCase())), z.boolean().optional());
const bool = (def) => z.preprocess(v => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(String(v).toLowerCase())), z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: num(5000),
  HOST: str("127.0.0.1"),
  CORS_ORIGIN: str("http://localhost:5173"),

  DATABASE_URL: str(),
  // Neon: the direct (non-pooled) connection string, used for migrations. Optional.
  DATABASE_URL_UNPOOLED: str(),
  // Empty = automatic: on for Neon hosts and URLs with sslmode=require, off otherwise.
  DB_SSL: optBool(),
  REDIS_URL: str(),
  QUEUE_DRIVER: z.enum(["bullmq", "memory"]).default("bullmq"),
  RUN_WORKERS_IN_API: bool(false),

  ASSEMBLYAI_API_KEY: str(),
  ASSEMBLYAI_SPEECH_MODELS: str("universal-3-5-pro,universal-2"),
  ASSEMBLYAI_EXPECTED_LANGUAGES: str("hi,en"),

  GEMINI_API_KEY: str(),
  GEMINI_MODEL: str("gemini-3.8-flash"),
  GEMINI_MAX_SINGLE_PASS_SECONDS: num(2700),
  GEMINI_CHUNK_SECONDS: num(1200),

  EMBEDDING_PROVIDER: z.enum(["gemini", "local", "hash", ""]).default(""),
  EMBEDDING_API_KEY: str(),
  EMBEDDING_MODEL: str(),
  EMBEDDING_CALIBRATION: z.string().regex(/^$|^\s*0?\.\d+\s*,\s*0?\.\d+\s*$/, "EMBEDDING_CALIBRATION must be floor,ceil e.g. 0.55,0.82").default(""),

  ANTHROPIC_API_KEY: str(),
  SKILL_MODE: z.enum(["agent-sdk", "manual", "disabled", "mock", ""]).default(""),
  SKILL_DIR: str(),
  SKILL_NAME: str(),
  SKILL_MODEL: str(),
  SKILL_MAX_TURNS: num(8),

  DOWNLOADER: z.enum(["yt-dlp", "mock", "none"]).default("yt-dlp"),
  YTDLP_PATH: str(),
  YTDLP_COOKIES_FILE: str(),
  ALLOWED_VIDEO_HOSTS: str("facebook.com,www.facebook.com,m.facebook.com,web.facebook.com,fb.watch"),

  TRANSCRIBER: z.enum(["assemblyai", "mock"]).default("assemblyai"),
  ANALYZER: z.enum(["gemini", "mock"]).default("gemini"),

  MATCH_THRESHOLD: num(DEFAULT_SCORING.matchThreshold),
  STORY_WEIGHT: num(DEFAULT_SCORING.storyWeight),
  CHARACTER_WEIGHT: num(DEFAULT_SCORING.characterWeight),
  DIALOGUE_WEIGHT: num(DEFAULT_SCORING.dialogueWeight),
  MIN_MATCH_CONFIDENCE: num(DEFAULT_SCORING.minMatchConfidence),

  MAX_CONCURRENT_JOBS: num(5),
  CONCURRENCY_DOWNLOAD: optNum(),
  CONCURRENCY_FFMPEG: optNum(),
  CONCURRENCY_TRANSCRIBE: optNum(),
  CONCURRENCY_ANALYZE: optNum(),
  CONCURRENCY_EMBED: optNum(),
  CONCURRENCY_GENERATE: optNum(),

  MAX_VIDEO_DURATION_SECONDS: num(900),
  MAX_VIDEO_SIZE_MB: num(500),
  MAX_UPLOAD_MB: num(10),
  MAX_ROWS_PER_BATCH: num(5000),

  DOWNLOAD_TIMEOUT_SECONDS: num(300),
  FFMPEG_TIMEOUT_SECONDS: num(180),
  TRANSCRIBE_TIMEOUT_SECONDS: num(900),
  ANALYZE_TIMEOUT_SECONDS: num(900),
  GENERATE_TIMEOUT_SECONDS: num(600),

  TEMP_VIDEO_DIR: str(),
  TEMP_AUDIO_DIR: str(),
  SKILL_EXCHANGE_DIR: str(),
  MEDIA_RETENTION_HOURS: num(24),

  LOG_LEVEL: str("info"),
});

function resolveDir(value, fallback) {
  return path.resolve(ROOT_DIR, value || fallback);
}

export function loadConfig(overrides = {}) {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const c = (v) => v ?? e.MAX_CONCURRENT_JOBS;
  // Default skill: the scriptwriter skill shipped next to the repository, when present.
  const skillDir = e.SKILL_DIR ? path.resolve(ROOT_DIR, e.SKILL_DIR)
    : existsSync(path.join(DEFAULT_SKILL_DIR, "SKILL.md")) ? DEFAULT_SKILL_DIR : "";
  return {
    env: e.NODE_ENV,
    isTest: e.NODE_ENV === "test",
    port: e.PORT,
    host: e.HOST,
    corsOrigin: e.CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean),
    databaseUrl: e.DATABASE_URL,
    databaseUrlUnpooled: e.DATABASE_URL_UNPOOLED,
    dbSsl: e.DB_SSL,
    redisUrl: e.REDIS_URL,
    queueDriver: e.QUEUE_DRIVER,
    runWorkersInApi: e.RUN_WORKERS_IN_API,
    logLevel: e.LOG_LEVEL,
    providers: {
      downloader: e.DOWNLOADER,
      transcriber: e.TRANSCRIBER,
      analyzer: e.ANALYZER,
      embedding: e.EMBEDDING_PROVIDER || (e.EMBEDDING_API_KEY || e.GEMINI_API_KEY ? "gemini" : "hash"),
    },
    assemblyai: {
      apiKey: e.ASSEMBLYAI_API_KEY,
      speechModels: e.ASSEMBLYAI_SPEECH_MODELS.split(",").map(s => s.trim()).filter(Boolean),
      expectedLanguages: e.ASSEMBLYAI_EXPECTED_LANGUAGES.split(",").map(s => s.trim()).filter(Boolean),
    },
    gemini: {
      apiKey: e.GEMINI_API_KEY,
      model: e.GEMINI_MODEL,
      maxSinglePassSeconds: e.GEMINI_MAX_SINGLE_PASS_SECONDS,
      chunkSeconds: e.GEMINI_CHUNK_SECONDS,
    },
    embedding: {
      apiKey: e.EMBEDDING_API_KEY || e.GEMINI_API_KEY,
      model: e.EMBEDDING_MODEL,
      calibration: e.EMBEDDING_CALIBRATION ? (([floor, ceil]) => ({ floor, ceil }))(e.EMBEDDING_CALIBRATION.split(",").map(Number)) : undefined,
    },
    skill: {
      mode: e.SKILL_MODE || (e.ANTHROPIC_API_KEY ? "agent-sdk" : skillDir ? "manual" : "disabled"),
      dir: skillDir,
      name: e.SKILL_NAME,
      model: e.SKILL_MODEL,
      maxTurns: e.SKILL_MAX_TURNS,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      exchangeDir: resolveDir(e.SKILL_EXCHANGE_DIR, "server/storage/skill-exchange"),
    },
    downloader: {
      ytdlpPath: e.YTDLP_PATH,
      cookiesFile: e.YTDLP_COOKIES_FILE,
      allowedHosts: e.ALLOWED_VIDEO_HOSTS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    },
    scoring: {
      matchThreshold: e.MATCH_THRESHOLD,
      storyWeight: e.STORY_WEIGHT,
      characterWeight: e.CHARACTER_WEIGHT,
      dialogueWeight: e.DIALOGUE_WEIGHT,
      minMatchConfidence: e.MIN_MATCH_CONFIDENCE,
    },
    concurrency: {
      download: c(e.CONCURRENCY_DOWNLOAD),
      audio: c(e.CONCURRENCY_FFMPEG),
      transcribe: c(e.CONCURRENCY_TRANSCRIBE),
      analyze: c(e.CONCURRENCY_ANALYZE),
      embed: c(e.CONCURRENCY_EMBED),
      match: c(e.CONCURRENCY_EMBED),
      generate: c(e.CONCURRENCY_GENERATE) || 2,
      script: c(e.CONCURRENCY_GENERATE) || 2,
    },
    limits: {
      maxVideoDurationSeconds: e.MAX_VIDEO_DURATION_SECONDS,
      maxVideoSizeBytes: e.MAX_VIDEO_SIZE_MB * 1024 * 1024,
      maxUploadBytes: e.MAX_UPLOAD_MB * 1024 * 1024,
      maxRowsPerBatch: e.MAX_ROWS_PER_BATCH,
    },
    timeouts: {
      download: e.DOWNLOAD_TIMEOUT_SECONDS * 1000,
      audio: e.FFMPEG_TIMEOUT_SECONDS * 1000,
      transcribe: e.TRANSCRIBE_TIMEOUT_SECONDS * 1000,
      analyze: e.ANALYZE_TIMEOUT_SECONDS * 1000,
      match: 120_000,
      generate: e.GENERATE_TIMEOUT_SECONDS * 1000,
      script: e.GENERATE_TIMEOUT_SECONDS * 1000,
    },
    storage: {
      videoDir: resolveDir(e.TEMP_VIDEO_DIR, "server/storage/videos"),
      audioDir: resolveDir(e.TEMP_AUDIO_DIR, "server/storage/audio"),
      retentionHours: e.MEDIA_RETENTION_HOURS,
    },
  };
}

/** Startup validation: returns { errors, warnings } describing missing configuration for the selected providers. */
export function checkConfig(cfg) {
  const errors = [];
  const warnings = [];
  if (!cfg.databaseUrl) errors.push("DATABASE_URL is required (PostgreSQL connection string).");
  if (cfg.queueDriver === "bullmq" && !cfg.redisUrl) errors.push("REDIS_URL is required when QUEUE_DRIVER=bullmq.");
  if (cfg.queueDriver === "memory" && cfg.env === "production") warnings.push("QUEUE_DRIVER=memory is for tests/local development only — jobs do not survive restarts.");
  if (cfg.providers.transcriber === "assemblyai" && !cfg.assemblyai.apiKey) warnings.push("ASSEMBLYAI_API_KEY is not set — transcription jobs will fail until it is configured.");
  if (cfg.providers.analyzer === "gemini" && !cfg.gemini.apiKey) warnings.push("GEMINI_API_KEY is not set — screenplay analysis jobs will fail until it is configured.");
  if (cfg.providers.embedding === "hash") warnings.push("EMBEDDING_PROVIDER=hash: lexical fallback, not semantic. Matching scores are less reliable — configure gemini or local embeddings.");
  if (cfg.providers.embedding === "gemini" && !cfg.embedding.apiKey) warnings.push("Gemini embeddings selected but no EMBEDDING_API_KEY/GEMINI_API_KEY is set.");
  if (cfg.skill.mode === "agent-sdk") {
    if (!cfg.skill.dir) errors.push("SKILL_DIR is required when SKILL_MODE=agent-sdk.");
    if (!cfg.skill.anthropicApiKey && !process.env.CLAUDE_CODE_USE_BEDROCK && !process.env.CLAUDE_CODE_USE_VERTEX && !process.env.CLAUDE_CODE_USE_FOUNDRY)
      warnings.push("SKILL_MODE=agent-sdk needs ANTHROPIC_API_KEY (or Bedrock/Vertex/Foundry credentials).");
  }
  if (cfg.skill.mode === "disabled") warnings.push("SKILL_MODE=disabled — qualifying videos get Story DNA but no generated script until a skill is configured.");
  if (cfg.skill.mode === "manual") warnings.push(`SKILL_MODE=manual — scripts are exported as job files for Claude Code (set ANTHROPIC_API_KEY to run the skill automatically). Skill: ${cfg.skill.dir || "not set"}`);
  const w = cfg.scoring;
  if (w.storyWeight + w.characterWeight + w.dialogueWeight !== 100) errors.push("STORY_WEIGHT + CHARACTER_WEIGHT + DIALOGUE_WEIGHT must equal 100.");
  return { errors, warnings };
}

export const config = loadConfig();
