// Helpers for integration tests: connect, migrate once, truncate between tests.
import { initDatabase, db } from "../../server/src/models/index.js";
import { migrateUp } from "../../server/src/migrations/migrate.js";

let migrated = false;

export async function setupTestDb() {
  const { sequelize } = await initDatabase(process.env.DATABASE_URL);
  if (!migrated) { await migrateUp(sequelize); migrated = true; }
  return db();
}

export async function resetDb() {
  const { sequelize } = db();
  await sequelize.query(
    "TRUNCATE batches, videos, transcripts, screenplay_analyses, match_results, story_dna, generated_scripts, processing_logs, settings, embedding_cache, datasets, scripts, api_usage RESTART IDENTITY CASCADE"
  );
}
