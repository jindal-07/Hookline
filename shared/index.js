// Shared constants and schemas used by the server, client and tests.
import { readFileSync } from "node:fs";

const load = name => JSON.parse(readFileSync(new URL(`./schemas/${name}`, import.meta.url), "utf8"));

export const screenplayAnalysisSchema = load("screenplay-analysis.schema.json");
export const normalizedTranscriptSchema = load("normalized-transcript.schema.json");
export const storyDnaSchema = load("story-dna.schema.json");
export const matchResultSchema = load("match-result.schema.json");

export * from "./constants.js";
