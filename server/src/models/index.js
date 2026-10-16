// Sequelize models. Schema changes go through migrations (src/migrations); these definitions must match them.
import { Sequelize, DataTypes } from "sequelize";
import { VIDEO_STATUS, TASK_STATUS, BATCH_STATUS, GENERATION_STATUS, BATCH_PURPOSE, PERFORMANCE, SCRIPT_STATUS } from "@reelscript/shared";

const { STRING, TEXT, INTEGER, BIGINT, FLOAT, BOOLEAN, JSONB, UUID, UUIDV4, DATE } = DataTypes;

const id = { type: UUID, defaultValue: UUIDV4, primaryKey: true };
const fk = (allowNull = false) => ({ type: UUID, allowNull });
const enumOf = (obj, def) => ({ type: STRING(32), allowNull: false, defaultValue: def, validate: { isIn: [Object.values(obj)] } });
// Snake-case timestamp attributes so API JSON matches the schema (created_at / updated_at).
const common = { underscored: true, timestamps: true, createdAt: "created_at", updatedAt: "updated_at" };
const createdOnly = { underscored: true, timestamps: true, createdAt: "created_at", updatedAt: false };

export function defineModels(sequelize) {
  const Batch = sequelize.define("Batch", {
    id,
    filename: { type: STRING(255), allowNull: false },
    status: enumOf(BATCH_STATUS, BATCH_STATUS.DRAFT),
    purpose: { type: STRING(16), allowNull: false, defaultValue: BATCH_PURPOSE.GENERATION, validate: { isIn: [Object.values(BATCH_PURPOSE)] } },
    total_videos: { type: INTEGER, allowNull: false, defaultValue: 0 },
    completed_videos: { type: INTEGER, allowNull: false, defaultValue: 0 },
    failed_videos: { type: INTEGER, allowNull: false, defaultValue: 0 },
    skipped_videos: { type: INTEGER, allowNull: false, defaultValue: 0 },
    validation_report: { type: JSONB, allowNull: false, defaultValue: {} },
    settings_snapshot: { type: JSONB },
    started_at: { type: DATE },
    finished_at: { type: DATE },
  }, { ...common, tableName: "batches" });

  const Video = sequelize.define("Video", {
    id,
    batch_id: fk(),
    video_url: { type: TEXT, allowNull: false },
    normalized_url: { type: TEXT, allowNull: false },
    external_id: { type: STRING(128) },
    source_row_number: { type: INTEGER, allowNull: false },
    title: { type: TEXT },
    category: { type: STRING(128) },
    views: { type: BIGINT },
    likes: { type: BIGINT },
    shares: { type: BIGINT },
    comments: { type: BIGINT },
    performance_label: { type: STRING(8), validate: { isIn: [Object.values(PERFORMANCE)] } },
    status: enumOf(VIDEO_STATUS, VIDEO_STATUS.PENDING),
    current_stage: { type: STRING(32) },
    transcript_status: enumOf(TASK_STATUS, TASK_STATUS.PENDING),
    analysis_status: enumOf(TASK_STATUS, TASK_STATUS.PENDING),
    generation_status: enumOf(GENERATION_STATUS, GENERATION_STATUS.NOT_ELIGIBLE),
    error_code: { type: STRING(64) },
    error_message: { type: TEXT },
    error_stage: { type: STRING(32) },
    content_hash: { type: STRING(64) },
    video_path: { type: TEXT },
    audio_path: { type: TEXT },
    has_audio: { type: BOOLEAN },
    media_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
    cancelled: { type: BOOLEAN, allowNull: false, defaultValue: false },
  }, { ...common, tableName: "videos" });

  const Transcript = sequelize.define("Transcript", {
    id,
    video_id: fk(),
    raw_transcript: { type: JSONB, allowNull: false },
    normalized_transcript: { type: JSONB, allowNull: false },
    language: { type: STRING(16) },
    duration_seconds: { type: FLOAT },
    provider_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
  }, { ...createdOnly, tableName: "transcripts" });

  const ScreenplayAnalysis = sequelize.define("ScreenplayAnalysis", {
    id,
    video_id: fk(),
    raw_analysis: { type: JSONB, allowNull: false },
    normalized_analysis: { type: JSONB, allowNull: false },
    model_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
  }, { ...createdOnly, tableName: "screenplay_analyses" });

  const MatchResult = sequelize.define("MatchResult", {
    id,
    video_id: fk(),
    overall_score: { type: FLOAT },
    story_score: { type: FLOAT },
    character_score: { type: FLOAT },
    dialogue_score: { type: FLOAT },
    confidence: { type: FLOAT, allowNull: false, defaultValue: 0 },
    match_status: { type: STRING(32), allowNull: false },
    eligible: { type: BOOLEAN, allowNull: false, defaultValue: false },
    evidence: { type: JSONB, allowNull: false, defaultValue: {} },
    reasoning: { type: TEXT },
    scoring_version: { type: STRING(16), allowNull: false },
    scoring_configuration: { type: JSONB, allowNull: false },
  }, { ...createdOnly, tableName: "match_results" });

  const StoryDNA = sequelize.define("StoryDNA", {
    id,
    video_id: fk(),
    story_dna: { type: JSONB, allowNull: false },
  }, { ...createdOnly, tableName: "story_dna" });

  const GeneratedScript = sequelize.define("GeneratedScript", {
    id,
    video_id: fk(),
    script_content: { type: TEXT },
    generation_status: { type: STRING(32), allowNull: false },
    skill_identifier: { type: STRING(255) },
    skill_version: { type: STRING(64) },
    generation_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
  }, { ...createdOnly, tableName: "generated_scripts" });

  const ProcessingLog = sequelize.define("ProcessingLog", {
    id,
    batch_id: fk(true),
    video_id: fk(true),
    stage: { type: STRING(32), allowNull: false },
    status: { type: STRING(32), allowNull: false },
    attempt: { type: INTEGER },
    duration_ms: { type: INTEGER },
    error_details: { type: JSONB },
    metadata: { type: JSONB, allowNull: false, defaultValue: {} },
  }, { ...createdOnly, tableName: "processing_logs" });

  const Setting = sequelize.define("Setting", {
    key: { type: STRING(64), primaryKey: true },
    value: { type: JSONB, allowNull: false },
  }, { ...common, tableName: "settings" });

  const EmbeddingCache = sequelize.define("EmbeddingCache", {
    id,
    text_hash: { type: STRING(64), allowNull: false },
    provider: { type: STRING(32), allowNull: false },
    model: { type: STRING(128), allowNull: false },
    model_version: { type: STRING(64), allowNull: false },
    dimensions: { type: INTEGER, allowNull: false },
    vector: { type: JSONB, allowNull: false },
  }, { ...createdOnly, tableName: "embedding_cache" });

  const Dataset = sequelize.define("Dataset", {
    id,
    name: { type: STRING(255), allowNull: false },
    status: { type: STRING(16), allowNull: false, defaultValue: "READY" },
    source_batch_ids: { type: JSONB, allowNull: false, defaultValue: [] },
    video_count: { type: INTEGER, allowNull: false, defaultValue: 0 },
    best_count: { type: INTEGER, allowNull: false, defaultValue: 0 },
    bad_count: { type: INTEGER, allowNull: false, defaultValue: 0 },
    excluded: { type: JSONB, allowNull: false, defaultValue: [] },
    profile: { type: JSONB, allowNull: false },
    builder_version: { type: STRING(16), allowNull: false },
  }, { ...createdOnly, tableName: "datasets" });

  const Script = sequelize.define("Script", {
    id,
    dataset_id: fk(true),
    title: { type: STRING(255) },
    brief: { type: JSONB, allowNull: false },
    status: enumOf(SCRIPT_STATUS, SCRIPT_STATUS.QUEUED),
    content: { type: TEXT },
    skill_identifier: { type: STRING(255) },
    skill_version: { type: STRING(64) },
    generation_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
    originality: { type: JSONB },
    error_message: { type: TEXT },
  }, { ...common, tableName: "scripts" });
  Dataset.hasMany(Script, { foreignKey: "dataset_id", as: "scripts" });
  Script.belongsTo(Dataset, { foreignKey: "dataset_id", as: "dataset" });

  Batch.hasMany(Video, { foreignKey: "batch_id", as: "videos", onDelete: "CASCADE" });
  Video.belongsTo(Batch, { foreignKey: "batch_id", as: "batch" });
  for (const [M, as] of [[Transcript, "transcripts"], [ScreenplayAnalysis, "analyses"], [MatchResult, "matches"], [StoryDNA, "storyDnas"], [GeneratedScript, "scripts"], [ProcessingLog, "logs"]]) {
    Video.hasMany(M, { foreignKey: "video_id", as, onDelete: "CASCADE" });
    M.belongsTo(Video, { foreignKey: "video_id", as: "video" });
  }
  Batch.hasMany(ProcessingLog, { foreignKey: "batch_id", as: "logs", onDelete: "CASCADE" });

  return { Batch, Video, Transcript, ScreenplayAnalysis, MatchResult, StoryDNA, GeneratedScript, ProcessingLog, Setting, EmbeddingCache, Dataset, Script };
}

let state = null;

const SSL_MODES = ["require", "verify-ca", "verify-full"];

/** SSL on/off: an explicit setting wins; otherwise on for Neon hosts and URLs that ask for it (sslmode=require). */
export function sslEnabled(databaseUrl, setting) {
  if (typeof setting === "boolean") return setting;
  try {
    const u = new URL(databaseUrl);
    return /\.neon\.tech$/i.test(u.hostname) || SSL_MODES.includes(u.searchParams.get("sslmode"));
  } catch { return false; }
}

/** SSL is configured explicitly below, so libpq-style SSL query parameters are removed from the URL. */
function stripSslParams(databaseUrl) {
  try {
    const u = new URL(databaseUrl);
    for (const k of ["sslmode", "sslrootcert", "channel_binding"]) u.searchParams.delete(k);
    return u.toString();
  } catch { return databaseUrl; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Wrong password / database missing / no permission: retrying won't help.
const FATAL_PG_CODES = new Set(["28P01", "28000", "3D000", "42501"]);

/**
 * A Sequelize instance for a PostgreSQL URL (local, Docker or Neon). Certificates are verified when SSL is on.
 * The first connection is retried: a Neon compute that scaled to zero needs a moment to wake up.
 */
export async function openSequelize(databaseUrl, { ssl, logging = false, pool = { max: 10 } } = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
  const useSsl = sslEnabled(databaseUrl, ssl);
  const sequelize = new Sequelize(stripSslParams(databaseUrl), {
    dialect: "postgres",
    logging,
    dialectOptions: { keepAlive: true, ...(useSsl ? { ssl: { require: true, rejectUnauthorized: true } } : {}) },
    pool: { min: 0, idle: 10_000, acquire: 60_000, ...pool },
  });
  for (let attempt = 1; ; attempt++) {
    try { await sequelize.authenticate(); break; }
    catch (err) {
      const code = err.original?.code || err.parent?.code;
      if (attempt >= 5 || FATAL_PG_CODES.has(code)) { await sequelize.close().catch(() => {}); throw err; }
      await sleep(attempt * 1000);
    }
  }
  return sequelize;
}

/** Connect (once) and define models. Pass a URL to override config (tests). */
export async function initDatabase(databaseUrl, { ssl, logging = false } = {}) {
  if (state) return state;
  const sequelize = await openSequelize(databaseUrl, { ssl, logging });
  // Transcripts are multilingual (Hindi etc.) — a non-UTF8 database silently can't store them.
  const [[{ encoding }]] = await sequelize.query("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()");
  if (encoding !== "UTF8") {
    await sequelize.close();
    throw new Error(`Database encoding is ${encoding}; UTF8 is required. Create it with: CREATE DATABASE <name> ENCODING 'UTF8' TEMPLATE template0;`);
  }
  state = { sequelize, models: defineModels(sequelize) };
  return state;
}

export function db() {
  if (!state) throw new Error("Database not initialised — call initDatabase() first");
  return state;
}

export async function closeDatabase() {
  if (state) { await state.sequelize.close(); state = null; }
}
