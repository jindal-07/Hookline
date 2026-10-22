// API usage ledger: one row per billable provider call (Gemini, AssemblyAI, Anthropic), priced when recorded.
// Backfills past Gemini analysis usage from processing_logs so history isn't lost.
import { DataTypes } from "sequelize";
import { randomUUID } from "node:crypto";

const { STRING, INTEGER, BIGINT, DECIMAL, JSONB, UUID, DATE, BOOLEAN } = DataTypes;

export async function up({ context: qi }) {
  await qi.createTable("api_usage", {
    id: { type: UUID, primaryKey: true, allowNull: false },
    provider: { type: STRING(16), allowNull: false },     // gemini | assemblyai | anthropic
    operation: { type: STRING(32), allowNull: false },    // video_analysis | text_analysis | embeddings | transcription | script
    model: { type: STRING(128) },
    requests: { type: INTEGER, allowNull: false, defaultValue: 1 },
    input_tokens: { type: BIGINT, allowNull: false, defaultValue: 0 },
    output_tokens: { type: BIGINT, allowNull: false, defaultValue: 0 },
    cached_tokens: { type: BIGINT, allowNull: false, defaultValue: 0 },
    audio_seconds: { type: DECIMAL(12, 3), allowNull: false, defaultValue: 0 },
    cost_usd: { type: DECIMAL(14, 6), allowNull: false, defaultValue: 0 },
    cost_source: { type: STRING(16), allowNull: false },  // provider (reported) | priced (our price table) | estimated
    succeeded: { type: BOOLEAN, allowNull: false, defaultValue: true },
    video_id: { type: UUID },
    batch_id: { type: UUID },
    script_id: { type: UUID },
    metadata: { type: JSONB, allowNull: false, defaultValue: {} },
    created_at: { type: DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("api_usage", ["created_at"]);
  await qi.addIndex("api_usage", ["provider", "created_at"]);

  // Backfill: successful Gemini analysis runs recorded before the ledger existed (priced at the intro rate).
  const [rows] = await qi.sequelize.query(`
    SELECT l.video_id, l.batch_id, l.created_at, l.metadata
    FROM processing_logs l
    WHERE l.stage = 'analyze' AND l.status = 'SUCCEEDED' AND l.metadata ? 'usage'`);
  const items = rows
    .filter(r => r.metadata?.usage && (r.metadata.usage.prompt_tokens || r.metadata.usage.output_tokens))
    .map(r => {
      const input = Number(r.metadata.usage.prompt_tokens || 0), output = Number(r.metadata.usage.output_tokens || 0);
      return {
        id: randomUUID(), provider: "gemini", operation: r.metadata.source === "screenplay_text" ? "text_analysis" : "video_analysis",
        model: r.metadata.model || null, requests: Number(r.metadata.attempts || 1), input_tokens: input, output_tokens: output,
        cost_usd: (input * 0.75 + output * 3.75) / 1e6, cost_source: "priced", succeeded: true,
        video_id: r.video_id, batch_id: r.batch_id, metadata: JSON.stringify({ backfilled: true }), created_at: r.created_at,
      };
    });
  if (items.length) await qi.bulkInsert("api_usage", items);
}

export async function down({ context: qi }) {
  await qi.dropTable("api_usage");
}
