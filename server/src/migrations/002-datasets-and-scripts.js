// Training datasets (best/bad labelled videos) and standalone scripts generated from them.
import { DataTypes } from "sequelize";

const { STRING, TEXT, INTEGER, JSONB, UUID, DATE } = DataTypes;
const now = { type: DATE, allowNull: false, defaultValue: DataTypes.NOW };

export async function up({ context: qi }) {
  await qi.addColumn("batches", "purpose", { type: STRING(16), allowNull: false, defaultValue: "generation" });
  await qi.addColumn("videos", "performance_label", { type: STRING(8) });
  await qi.addIndex("batches", ["purpose"]);
  await qi.addIndex("videos", ["performance_label"]);

  await qi.createTable("datasets", {
    id: { type: UUID, primaryKey: true, allowNull: false },
    name: { type: STRING(255), allowNull: false },
    status: { type: STRING(16), allowNull: false, defaultValue: "READY" },
    source_batch_ids: { type: JSONB, allowNull: false, defaultValue: [] },
    video_count: { type: INTEGER, allowNull: false, defaultValue: 0 },
    best_count: { type: INTEGER, allowNull: false, defaultValue: 0 },
    bad_count: { type: INTEGER, allowNull: false, defaultValue: 0 },
    excluded: { type: JSONB, allowNull: false, defaultValue: [] },
    profile: { type: JSONB, allowNull: false },
    builder_version: { type: STRING(16), allowNull: false },
    created_at: now,
  });
  await qi.addIndex("datasets", ["created_at"]);

  await qi.createTable("scripts", {
    id: { type: UUID, primaryKey: true, allowNull: false },
    dataset_id: { type: UUID, references: { model: "datasets", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    title: { type: STRING(255) },
    brief: { type: JSONB, allowNull: false },
    status: { type: STRING(32), allowNull: false, defaultValue: "QUEUED" },
    content: { type: TEXT },
    skill_identifier: { type: STRING(255) },
    skill_version: { type: STRING(64) },
    generation_metadata: { type: JSONB, allowNull: false, defaultValue: {} },
    originality: { type: JSONB },
    error_message: { type: TEXT },
    created_at: now,
    updated_at: now,
  });
  await qi.addIndex("scripts", ["created_at"]);
  await qi.addIndex("scripts", ["status"]);
}

export async function down({ context: qi }) {
  await qi.dropTable("scripts");
  await qi.dropTable("datasets");
  await qi.removeColumn("videos", "performance_label");
  await qi.removeColumn("batches", "purpose");
}
