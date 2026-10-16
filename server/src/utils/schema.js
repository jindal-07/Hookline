// JSON-schema validation for AI outputs (Ajv, draft 2020-12).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { screenplayAnalysisSchema, normalizedTranscriptSchema, storyDnaSchema, matchResultSchema } from "@reelscript/shared";

const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false });
addFormats(ajv);

const compiled = {
  screenplay: ajv.compile(screenplayAnalysisSchema),
  transcript: ajv.compile(normalizedTranscriptSchema),
  storyDna: ajv.compile(storyDnaSchema),
  match: ajv.compile(matchResultSchema),
};

/** @returns {{ valid: boolean, errors: string[] }} */
export function validate(kind, data) {
  const fn = compiled[kind];
  if (!fn) throw new Error(`Unknown schema ${kind}`);
  const valid = fn(data);
  return { valid, errors: valid ? [] : fn.errors.slice(0, 20).map(e => `${e.instancePath || "/"} ${e.message}`) };
}

/** Parse model output as JSON, tolerating code fences. Returns { ok, value, error }. */
export function parseJsonLoose(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "empty response" };
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1];
  try { return { ok: true, value: JSON.parse(t) }; } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
}
