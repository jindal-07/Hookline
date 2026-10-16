import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, resetDb } from "../setup/db.js";
import { closeDatabase } from "../../server/src/models/index.js";
import { createMigrator } from "../../server/src/migrations/migrate.js";

describe("database migrations", () => {
  let ctx;
  beforeAll(async () => { ctx = await setupTestDb(); await resetDb(); });
  afterAll(closeDatabase);

  it("applies all migrations and creates every table", async () => {
    const tables = (await ctx.sequelize.getQueryInterface().showAllTables()).sort();
    for (const t of ["batches", "videos", "transcripts", "screenplay_analyses", "match_results", "story_dna", "generated_scripts", "processing_logs", "settings", "embedding_cache"])
      expect(tables).toContain(t);
    expect(await createMigrator(ctx.sequelize).pending()).toHaveLength(0);
  });

  it("enforces unique normalized URLs per batch and cascades deletes", async () => {
    const { Batch, Video, Transcript } = ctx.models;
    const b = await Batch.create({ filename: "a.xlsx" });
    const v = await Video.create({ batch_id: b.id, video_url: "u", normalized_url: "n", source_row_number: 2 });
    await expect(Video.create({ batch_id: b.id, video_url: "u2", normalized_url: "n", source_row_number: 3 })).rejects.toThrow();
    await Transcript.create({ video_id: v.id, raw_transcript: { a: 1 }, normalized_transcript: { language: "hi" } });
    await b.destroy();
    expect(await Transcript.count()).toBe(0);
  });

  it("stores and queries JSONB", async () => {
    const { Batch } = ctx.models;
    await Batch.create({ filename: "j.xlsx", validation_report: { invalid: [{ row: 3 }] } });
    const [rows] = await ctx.sequelize.query("SELECT validation_report->'invalid'->0->>'row' AS r FROM batches WHERE filename='j.xlsx'");
    expect(rows[0].r).toBe("3");
  });
});
