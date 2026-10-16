// Runtime scoring settings: env defaults overridden by values saved from the dashboard (settings table).
import { z } from "zod";
import { db } from "../models/index.js";
import { config } from "../config/env.js";
import { validateScoringConfig } from "./matching/MatchingService.js";
import { badRequest } from "../utils/errors.js";

export const scoringPatchSchema = z.object({
  matchThreshold: z.number().min(0).max(100).optional(),
  storyWeight: z.number().min(0).max(100).optional(),
  characterWeight: z.number().min(0).max(100).optional(),
  dialogueWeight: z.number().min(0).max(100).optional(),
  minMatchConfidence: z.number().min(0).max(1).optional(),
  contradictionPenalty: z.number().min(0).max(50).optional(),
}).strict();

const DEFAULTS = () => ({ ...config.scoring, contradictionPenalty: 5 });

export async function getScoringSettings() {
  const row = await db().models.Setting.findByPk("scoring");
  return { ...DEFAULTS(), ...(row?.value || {}) };
}

export async function updateScoringSettings(patch) {
  const parsed = scoringPatchSchema.safeParse(patch);
  if (!parsed.success) throw badRequest("Invalid settings", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`));
  const next = { ...(await getScoringSettings()), ...parsed.data };
  const errors = validateScoringConfig(next);
  if (errors.length) throw badRequest("Invalid settings", errors);
  await db().models.Setting.upsert({ key: "scoring", value: next });
  return next;
}
