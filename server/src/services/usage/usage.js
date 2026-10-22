// API usage ledger: records every billable provider call and summarises spend against the credits you added.
// Token and audio counts are what the providers report. Costs: Anthropic reports its own; Gemini and AssemblyAI
// are priced at record time from the editable price table; Gemini embeddings are estimated (no token count returned).
import { randomUUID } from "node:crypto";
import { QueryTypes } from "sequelize";
import { z } from "zod";
import { db } from "../../models/index.js";
import { logger } from "../../utils/logger.js";
import { badRequest } from "../../utils/errors.js";

export const PROVIDERS = ["gemini", "assemblyai", "anthropic"];

// USD. Gemini 3.8 Flash intro rates (reported to double from 2027-01-01); AssemblyAI Universal-3.5 Pro + diarization.
export const DEFAULT_PRICES = {
  gemini: { input_per_million: 0.75, output_per_million: 3.75, embedding_per_million: 0.15 },
  assemblyai: { per_audio_hour: 0.23 },
  anthropic: { input_per_million: 2, output_per_million: 10 }, // only used if the SDK doesn't report a cost
};

const pricesSchema = z.object({
  gemini: z.object({ input_per_million: z.number().min(0).max(1000), output_per_million: z.number().min(0).max(1000), embedding_per_million: z.number().min(0).max(1000) }).partial(),
  assemblyai: z.object({ per_audio_hour: z.number().min(0).max(100) }).partial(),
  anthropic: z.object({ input_per_million: z.number().min(0).max(1000), output_per_million: z.number().min(0).max(1000) }).partial(),
}).partial().strict();

const creditSchema = z.object({ amount_usd: z.number().min(0).max(1_000_000), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable();
const creditsSchema = z.object(Object.fromEntries(PROVIDERS.map(p => [p, creditSchema]))).partial().strict();

const setting = async (key, fallback) => (await db().models.Setting.findByPk(key))?.value ?? fallback;

export async function getPrices() {
  const saved = await setting("api_prices", {});
  return Object.fromEntries(PROVIDERS.map(p => [p, { ...DEFAULT_PRICES[p], ...(saved[p] || {}) }]));
}

export async function getCredits() {
  const saved = await setting("api_credits", {});
  return Object.fromEntries(PROVIDERS.map(p => [p, saved[p] ?? null]));
}

export async function updateUsageSettings({ prices, credits }) {
  const { Setting } = db().models;
  if (prices) {
    const p = pricesSchema.safeParse(prices);
    if (!p.success) throw badRequest("Invalid prices", p.error.issues.map(i => `${i.path.join(".")}: ${i.message}`));
    const cur = await setting("api_prices", {});
    const next = { ...cur };
    for (const [k, v] of Object.entries(p.data)) next[k] = { ...(cur[k] || {}), ...v };
    await Setting.upsert({ key: "api_prices", value: next });
  }
  if (credits) {
    const c = creditsSchema.safeParse(credits);
    if (!c.success) throw badRequest("Invalid credits", c.error.issues.map(i => `${i.path.join(".")}: ${i.message}`));
    await Setting.upsert({ key: "api_credits", value: { ...(await setting("api_credits", {})), ...c.data } });
  }
  return { prices: await getPrices(), credits: await getCredits() };
}

/** Price a call. Returns { cost_usd, cost_source }. */
export function priceCall(evt, prices) {
  if (evt.provider === "anthropic" && typeof evt.reported_cost_usd === "number") return { cost_usd: evt.reported_cost_usd, cost_source: "provider" };
  if (evt.provider === "gemini" && evt.operation === "embeddings")
    return { cost_usd: (evt.input_tokens || 0) * prices.gemini.embedding_per_million / 1e6, cost_source: "estimated" };
  if (evt.provider === "gemini")
    return { cost_usd: ((evt.input_tokens || 0) * prices.gemini.input_per_million + (evt.output_tokens || 0) * prices.gemini.output_per_million) / 1e6, cost_source: "priced" };
  if (evt.provider === "assemblyai") return { cost_usd: (evt.audio_seconds || 0) / 3600 * prices.assemblyai.per_audio_hour, cost_source: "priced" };
  return { cost_usd: ((evt.input_tokens || 0) * prices.anthropic.input_per_million + (evt.output_tokens || 0) * prices.anthropic.output_per_million) / 1e6, cost_source: "priced" };
}

/**
 * Record one billable call. Never throws: usage tracking must not break a pipeline stage.
 * evt: { provider, operation, model?, requests?, input_tokens?, output_tokens?, cached_tokens?, audio_seconds?,
 *        reported_cost_usd?, succeeded?, video_id?, batch_id?, script_id?, metadata? }
 */
export async function recordUsage(evt) {
  try {
    const { ApiUsage } = db().models;
    const { cost_usd, cost_source } = priceCall(evt, await getPrices());
    await ApiUsage.create({
      id: randomUUID(), provider: evt.provider, operation: evt.operation, model: evt.model ?? null, requests: evt.requests ?? 1,
      input_tokens: Math.round(evt.input_tokens || 0), output_tokens: Math.round(evt.output_tokens || 0), cached_tokens: Math.round(evt.cached_tokens || 0),
      audio_seconds: evt.audio_seconds || 0, cost_usd, cost_source, succeeded: evt.succeeded ?? true,
      video_id: evt.video_id ?? null, batch_id: evt.batch_id ?? null, script_id: evt.script_id ?? null, metadata: evt.metadata || {},
    });
  } catch (err) {
    logger.warn({ err: err.message, provider: evt.provider }, "could not record API usage");
  }
}

const PERIODS = { "24h": "1 day", "7d": "7 days", "30d": "30 days", all: null };

/** Usage summary for a period, plus each provider's spend since its credit date and what's left. */
export async function usageSummary({ period = "30d" } = {}) {
  const { sequelize } = db();
  const interval = PERIODS[period] ?? PERIODS["30d"];
  const where = interval ? `WHERE created_at >= now() - interval '${interval}'` : "";
  const num = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ["provider", "operation", "day", "model"].includes(k) ? v : Number(v)]));

  const byOperation = (await sequelize.query(`
    SELECT provider, operation,
      SUM(requests)::bigint AS requests, SUM(input_tokens)::bigint AS input_tokens, SUM(output_tokens)::bigint AS output_tokens,
      SUM(cached_tokens)::bigint AS cached_tokens, SUM(audio_seconds) AS audio_seconds, SUM(cost_usd) AS cost_usd,
      SUM(CASE WHEN succeeded THEN 0 ELSE requests END)::bigint AS failed_requests,
      BOOL_OR(cost_source = 'estimated') AS estimated
    FROM api_usage ${where} GROUP BY provider, operation ORDER BY provider, operation`, { type: QueryTypes.SELECT })).map(r => ({ ...num(r), estimated: r.estimated }));

  const daily = (await sequelize.query(`
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, provider, SUM(cost_usd) AS cost_usd
    FROM api_usage ${where} GROUP BY 1, 2 ORDER BY 1`, { type: QueryTypes.SELECT })).map(num);

  const credits = await getCredits();
  const providers = {};
  for (const p of PROVIDERS) {
    const ops = byOperation.filter(o => o.provider === p);
    const sum = (k) => ops.reduce((t, o) => t + (o[k] || 0), 0);
    const credit = credits[p];
    let spentSinceCredit = null;
    if (credit) {
      const [row] = await sequelize.query(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM api_usage WHERE provider = :p AND created_at >= :since`,
        { replacements: { p, since: credit.since }, type: QueryTypes.SELECT });
      spentSinceCredit = Number(row.c);
    }
    providers[p] = {
      requests: sum("requests"), failed_requests: sum("failed_requests"), input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"),
      cached_tokens: sum("cached_tokens"), audio_seconds: sum("audio_seconds"), cost_usd: sum("cost_usd"), estimated: ops.some(o => o.estimated),
      credit: credit ? { ...credit, used_usd: spentSinceCredit, remaining_usd: Math.max(0, credit.amount_usd - spentSinceCredit) } : null,
    };
  }
  return { period, providers, operations: byOperation, daily, prices: await getPrices() };
}
