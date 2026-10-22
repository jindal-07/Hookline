// API usage ledger: recording, pricing, period summaries and credits, through the real API and Postgres.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../../server/src/app.js";
import { setupPipeline, teardownPipeline } from "../setup/pipeline.js";
import { closeDatabase, db } from "../../server/src/models/index.js";
import { recordUsage, priceCall, DEFAULT_PRICES } from "../../server/src/services/usage/usage.js";
import { GeminiVideoAnalyzer } from "../../server/src/services/screenplay/GeminiVideoAnalyzer.js";
import { baseScreenplay } from "../fixtures/matching.js";

let app;
beforeEach(async () => {
  await setupPipeline();
  app = createApp();
  await db().sequelize.query("TRUNCATE api_usage");
  await db().models.Setting.destroy({ where: { key: ["api_prices", "api_credits"] } });
});
afterEach(teardownPipeline);
afterAll(closeDatabase);

describe("API usage", () => {
  it("prices each provider the way it bills", () => {
    expect(priceCall({ provider: "gemini", operation: "video_analysis", input_tokens: 1e6, output_tokens: 1e6 }, DEFAULT_PRICES)).toEqual({ cost_usd: 4.5, cost_source: "priced" });
    expect(priceCall({ provider: "gemini", operation: "embeddings", input_tokens: 2e6 }, DEFAULT_PRICES)).toEqual({ cost_usd: 0.3, cost_source: "estimated" });
    expect(priceCall({ provider: "assemblyai", operation: "transcription", audio_seconds: 7200 }, DEFAULT_PRICES)).toEqual({ cost_usd: 0.46, cost_source: "priced" });
    expect(priceCall({ provider: "anthropic", operation: "script", reported_cost_usd: 0.137, input_tokens: 9e9 }, DEFAULT_PRICES)).toEqual({ cost_usd: 0.137, cost_source: "provider" });
  });

  it("summarises recorded calls per provider and operation, including retried attempts", async () => {
    await recordUsage({ provider: "gemini", operation: "video_analysis", model: "gemini-3.8-flash", input_tokens: 100_000, output_tokens: 10_000 });
    await recordUsage({ provider: "gemini", operation: "video_analysis", model: "gemini-3.8-flash", input_tokens: 100_000, output_tokens: 9_000, succeeded: false });
    await recordUsage({ provider: "assemblyai", operation: "transcription", audio_seconds: 318 });
    await recordUsage({ provider: "anthropic", operation: "script", input_tokens: 40_000, output_tokens: 5_000, cached_tokens: 30_000, reported_cost_usd: 0.12, requests: 4 });

    const { body } = await request(app).get("/api/usage?period=all").expect(200);
    expect(body.providers.gemini).toMatchObject({ requests: 2, failed_requests: 1, input_tokens: 200_000, output_tokens: 19_000 });
    expect(body.providers.gemini.cost_usd).toBeCloseTo((200_000 * 0.75 + 19_000 * 3.75) / 1e6, 6);
    expect(body.providers.assemblyai.audio_seconds).toBe(318);
    expect(body.providers.assemblyai.cost_usd).toBeCloseTo(318 / 3600 * 0.23, 6);
    expect(body.providers.anthropic).toMatchObject({ requests: 4, cost_usd: 0.12, cached_tokens: 30_000 });
    expect(body.operations.map(o => `${o.provider}/${o.operation}`)).toEqual(["anthropic/script", "assemblyai/transcription", "gemini/video_analysis"]);
    expect(body.daily.length).toBeGreaterThan(0);
    await request(app).get("/api/usage?period=forever").expect(400);
  });

  it("tracks credits left since the date they were added, and prices future calls at edited prices", async () => {
    await recordUsage({ provider: "anthropic", operation: "script", reported_cost_usd: 1.5 });
    await request(app).patch("/api/usage/settings").send({ credits: { anthropic: { amount_usd: 10, since: "2020-01-01" } } }).expect(200);
    let u = (await request(app).get("/api/usage")).body.providers.anthropic;
    expect(u.credit).toMatchObject({ amount_usd: 10, used_usd: 1.5, remaining_usd: 8.5 });

    await request(app).patch("/api/usage/settings").send({ prices: { assemblyai: { per_audio_hour: 1 } } }).expect(200);
    await recordUsage({ provider: "assemblyai", operation: "transcription", audio_seconds: 3600 });
    u = (await request(app).get("/api/usage")).body;
    expect(u.providers.assemblyai.cost_usd).toBeCloseTo(1, 6);
    expect(u.prices.assemblyai.per_audio_hour).toBe(1);
    expect(u.prices.gemini.input_per_million).toBe(0.75); // untouched defaults remain

    await request(app).patch("/api/usage/settings").send({ credits: { anthropic: null } }).expect(200);
    expect((await request(app).get("/api/usage")).body.providers.anthropic.credit).toBeNull();
    await request(app).patch("/api/usage/settings").send({ prices: { gemini: { input_per_million: -1 } } }).expect(400);
    await request(app).patch("/api/usage/settings").send({ credits: { gemini: { amount_usd: 5, since: "yesterday" } } }).expect(400);
  });

  it("records every Gemini attempt with the tokens Gemini reports, including rejected output that was retried", async () => {
    const replies = ["{ not json", JSON.stringify(baseScreenplay())];
    const client = { models: { generateContent: async () => ({ text: replies.shift(), usageMetadata: { promptTokenCount: 2500, candidatesTokenCount: 6000, thoughtsTokenCount: 3000, totalTokenCount: 11500 } }) } };
    const g = new GeminiVideoAnalyzer({ client, model: "gemini-3.8-flash", maxValidationRetries: 2 });
    const r = await g.analyzeScreenplayText("INT. ROOM - DAY\n\nANNA\nHello.", { durationSeconds: 60 });
    expect(r.metadata.attempts).toBe(2);
    const rows = await db().models.ApiUsage.findAll({ order: [["created_at", "ASC"]] });
    expect(rows.map(x => [x.operation, Number(x.input_tokens), Number(x.output_tokens), x.succeeded])).toEqual([
      ["text_analysis", 2500, 9000, false],
      ["text_analysis", 2500, 9000, true],
    ]);
  });

  it("never breaks the caller when recording fails", async () => {
    await expect(recordUsage({ provider: "gemini", operation: null })).resolves.toBeUndefined();
  });
});
