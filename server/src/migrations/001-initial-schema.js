// Initial schema. Mirrors src/models/index.js.
import { DataTypes } from "sequelize";

const { STRING, TEXT, INTEGER, BIGINT, FLOAT, BOOLEAN, JSONB, UUID, DATE } = DataTypes;
const now = { type: DATE, allowNull: false, defaultValue: DataTypes.NOW };
const pk = { type: UUID, primaryKey: true, allowNull: false };
const ref = (table, allowNull = false) => ({ type: UUID, allowNull, references: { model: table, key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" });

export async function up({ context: qi }) {
  await qi.createTable("batches", {
    id: pk,
    filename: { type: STRING(255), allowNull: false },
    status: { type: STRING(32), allowNull: false, defaultValue: "DRAFT" },
    total_videos: { type: INTEGER, allowNull: false, defaultValue: 0 },
    completed_videos: { type: INTEGER, allowNull: false, defaultValue: 0 },
    failed_videos: { type: INTEGER, allowNull: false, defaultValue: 0 },
    skipped_videos: { type: INTEGER, allowNull: false, defaultValue: 0 },
    validation_report: { type: JSONB, allowNull: false, defaultValue: {} },
    settings_snapshot: { type: JSONB },
    started_at: { type: DATE },
    finished_at: { type: DATE },
    created_at: now,
    updated_at: now,
  });
  await qi.addIndex("batches", ["created_at"]);

  await qi.createTable("videos", {
    id: pk,
    batch_id: ref("batches"),
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
    status: { type: STRING(32), allowNull: false, defaultValue: "PENDING" },
    current_stage: { type: STRING(32) },
    transcript_status: { type: STRING(32), allowNull: false, defaultValue: "PENDING" },
    analysis_status: { type: STRING(32), allowNull: false, defaultValue: "PENDING" },
    generation_status: { type: STRING(32), allowNull: false, defaultValue: "NOT_ELIGIBLE" },
    error_code: { type: STRING(64) },
    error_message: { type: TEXT },
    error_stage: { type: STRING(32) },
    content_hash: { type: STRING(64) },
    video_path: { type: TEXT },
    audio_path: { type: TEXT },
    has_audio: { type: BOOLEAN },
    media_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
    cancelled: { type: BOOLEAN, allowNull: false, defaultValue: false },
    created_at: now,
    updated_at: now,
  });
  await qi.addIndex("videos", ["batch_id", "normalized_url"], { unique: true, name: "videos_batch_url_unique" });
  await qi.addIndex("videos", ["normalized_url"]);
  await qi.addIndex("videos", ["status"]);
  await qi.addIndex("videos", ["category"]);
  await qi.addIndex("videos", ["content_hash"]);

  const child = (extra) => ({ id: pk, video_id: ref("videos"), ...extra, created_at: now });

  await qi.createTable("transcripts", child({
    raw_transcript: { type: JSONB, allowNull: false },
    normalized_transcript: { type: JSONB, allowNull: false },
    language: { type: STRING(16) },
    duration_seconds: { type: FLOAT },
    provider_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
  }));
  await qi.addIndex("transcripts", ["video_id"]);

  await qi.createTable("screenplay_analyses", child({
    raw_analysis: { type: JSONB, allowNull: false },
    normalized_analysis: { type: JSONB, allowNull: false },
    model_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
  }));
  await qi.addIndex("screenplay_analyses", ["video_id"]);

  await qi.createTable("match_results", child({
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
  }));
  await qi.addIndex("match_results", ["video_id"]);
  await qi.addIndex("match_results", ["overall_score"]);

  await qi.createTable("story_dna", child({ story_dna: { type: JSONB, allowNull: false } }));
  await qi.addIndex("story_dna", ["video_id"]);

  await qi.createTable("generated_scripts", child({
    script_content: { type: TEXT },
    generation_status: { type: STRING(32), allowNull: false },
    skill_identifier: { type: STRING(255) },
    skill_version: { type: STRING(64) },
    generation_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
  }));
  await qi.addIndex("generated_scripts", ["video_id"]);

  await qi.createTable("processing_logs", {
    id: pk,
    batch_id: ref("batches", true),
    video_id: ref("videos", true),
    stage: { type: STRING(32), allowNull: false },
    status: { type: STRING(32), allowNull: false },
    attempt: { type: INTEGER },
    duration_ms: { type: INTEGER },
    error_details: { type: JSONB },
    metadata: { type: JSONB, allowNull: false, defaultValue: {} },
    created_at: now,
  });
  await qi.addIndex("processing_logs", ["video_id", "created_at"]);
  await qi.addIndex("processing_logs", ["batch_id"]);

  await qi.createTable("settings", {
    key: { type: STRING(64), primaryKey: true },
    value: { type: JSONB, allowNull: false },
    created_at: now,
    updated_at: now,
  });

  await qi.createTable("embedding_cache", {
    id: pk,
    text_hash: { type: STRING(64), allowNull: false },
    provider: { type: STRING(32), allowNull: false },
    model: { type: STRING(128), allowNull: false },
    model_version: { type: STRING(64), allowNull: false },
    dimensions: { type: INTEGER, allowNull: false },
    vector: { type: JSONB, allowNull: false },
    created_at: now,
  });
  await qi.addIndex("embedding_cache", ["text_hash", "provider", "model", "model_version"], { unique: true, name: "embedding_cache_key_unique" });
}

export async function down({ context: qi }) {
  for (const t of ["embedding_cache", "settings", "processing_logs", "generated_scripts", "story_dna", "match_results", "screenplay_analyses", "transcripts", "videos", "batches"])
    await qi.dropTable(t);
}
