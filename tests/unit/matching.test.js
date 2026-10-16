import { describe, it, expect } from "vitest";
import { MatchingService, validateScoringConfig } from "../../server/src/services/matching/MatchingService.js";
import { HashEmbeddingService } from "../../server/src/services/embeddings/providers.js";
import { calibrate, deriveCalibration, cosine } from "../../server/src/services/embeddings/EmbeddingService.js";
import { ConceptEmbeddingService } from "../fixtures/concept-embeddings.js";
import { baseScreenplay, normalized, HINDI_UTTERANCES, HINGLISH_UTTERANCES, SCRAMBLED_UTTERANCES, CONTRADICTORY_UTTERANCES } from "../fixtures/matching.js";
import { validate } from "../../server/src/utils/schema.js";

const svc = (config) => new MatchingService({ embeddings: new ConceptEmbeddingService(), config });
const compare = async (utterances, { screenplay = baseScreenplay(), tx = {}, config } = {}) =>
  svc(config).compare({ transcript: await normalized(utterances, tx), screenplayAnalysis: screenplay, videoId: "video_001" });

describe("MatchingService — fixtures", () => {
  it("high semantic match with different wording and language (Hindi speech vs English analysis) → MATCHED", async () => {
    const r = await compare(HINDI_UTTERANCES);
    expect(r.match_status).toBe("MATCHED");
    expect(r.eligible).toBe(true);
    expect(r.story_score).toBeGreaterThanOrEqual(75);
    expect(r.character_score).toBeGreaterThanOrEqual(75);
    expect(r.dialogue_score).toBeGreaterThanOrEqual(75);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.evidence.mismatches).toHaveLength(0);
    expect(r.evidence.character_matches.filter(m => m.type === "speaker_mapping").map(m => [m.speaker_id, m.character_id]).sort())
      .toEqual([["SPEAKER_A", "CHAR_001"], ["SPEAKER_B", "CHAR_002"], ["SPEAKER_C", "CHAR_003"]]);
    expect(validate("match", r).valid).toBe(true);
  });

  it("multilingual / code-switched (Hinglish, romanised) dialogue → MATCHED", async () => {
    const r = await compare(HINGLISH_UTTERANCES, { tx: { language: "hi" } });
    expect(r.match_status).toBe("MATCHED");
    expect(r.overall_score).toBeGreaterThanOrEqual(75);
  });

  it("similar wording but a different story (scrambled order and speakers) → not eligible", async () => {
    const good = await compare(HINDI_UTTERANCES);
    const r = await compare(SCRAMBLED_UTTERANCES);
    expect(r.eligible).toBe(false);
    expect(r.overall_score).toBeLessThan(good.overall_score - 15);
    expect(r.evidence.mismatches.length).toBeGreaterThan(0);
  });

  it("matching story with uncertain character identities (no diarization) → mapping marked uncertain, lower confidence", async () => {
    const good = await compare(HINDI_UTTERANCES);
    const r = await compare(HINDI_UTTERANCES, { tx: { diarized: false } });
    expect(r.match_status).not.toBe("INCONCLUSIVE");
    expect(r.evidence.uncertain_elements.some(u => u.type === "speaker_identity")).toBe(true);
    expect(r.evidence.components.character.speaker_consistency).toBeNull();
    expect(r.character_score).toBeLessThanOrEqual(85); // identity-uncertainty discount
    expect(r.confidence).toBeLessThan(good.confidence);
    expect(r.story_score).toBeGreaterThanOrEqual(75);
  });

  it("incomplete transcript → INCONCLUSIVE", async () => {
    const r = await compare(HINDI_UTTERANCES.slice(0, 2), { tx: { duration: 14 } });
    expect(r.match_status).toBe("INCONCLUSIVE");
    expect(r.inconclusive_reasons).toContain("transcript_incomplete");
    expect(r.eligible).toBe(false);
  });

  it("contradictory screenplay and transcript → MISMATCHED with explicit contradictions", async () => {
    const r = await compare(CONTRADICTORY_UTTERANCES);
    expect(r.match_status).toBe("MISMATCHED");
    expect(r.overall_score).toBeLessThan(40);
    expect(r.evidence.mismatches.some(m => m.type === "dialogue_contradiction")).toBe(true);
  });

  it("silent video → INCONCLUSIVE (dialogue matching not meaningful)", async () => {
    const silent = baseScreenplay({ dialogue_moments: [] });
    silent.scenes.forEach(s => { s.dialogue_summary = ""; });
    const r = await compare([], { screenplay: silent });
    expect(r.match_status).toBe("INCONCLUSIVE");
    expect(r.inconclusive_reasons).toContain("little_or_no_speech");
    expect(r.overall_score).toBeNull();
  });

  it("Hindi transcript with a non-multilingual (lexical) embedding model → INCONCLUSIVE, not a false score", async () => {
    const lexical = new MatchingService({ embeddings: new HashEmbeddingService() });
    const r = await lexical.compare({ transcript: await normalized(HINDI_UTTERANCES), screenplayAnalysis: baseScreenplay() });
    expect(r.match_status).toBe("INCONCLUSIVE");
    expect(r.inconclusive_reasons).toContain("language_incompatible");
  });

  it("missing or malformed screenplay → INCONCLUSIVE", async () => {
    const t = await normalized(HINDI_UTTERANCES);
    expect((await svc().compare({ transcript: t, screenplayAnalysis: null })).inconclusive_reasons).toContain("screenplay_missing");
    expect((await svc().compare({ transcript: t, screenplayAnalysis: { scenes: "nope" } })).inconclusive_reasons).toContain("screenplay_malformed");
    expect((await svc().compare({ transcript: null, screenplayAnalysis: baseScreenplay() })).inconclusive_reasons).toContain("transcript_missing");
  });
});

describe("MatchingService — scoring rules", () => {
  it("overall = story×0.40 + character×0.30 + dialogue×0.30, unrounded, within 0–100", async () => {
    const r = await compare(HINDI_UTTERANCES);
    const expected = r.story_score * 0.4 + r.character_score * 0.3 + r.dialogue_score * 0.3;
    expect(r.overall_score).toBeCloseTo(expected, 10);
    for (const k of ["overall_score", "story_score", "character_score", "dialogue_score"]) {
      expect(r[k]).toBeGreaterThanOrEqual(0);
      expect(r[k]).toBeLessThanOrEqual(100);
    }
    expect(Number.isInteger(r.overall_score)).toBe(false); // not rounded internally
  });

  it("uses configurable weights", async () => {
    const r = await compare(HINDI_UTTERANCES, { config: { storyWeight: 100, characterWeight: 0, dialogueWeight: 0 } });
    expect(r.overall_score).toBeCloseTo(r.story_score, 10);
    expect(r.scoring_configuration.weights).toEqual({ story: 100, character: 0, dialogue: 0 });
  });

  it("validates weights (non-negative, sum to 100) and thresholds", () => {
    const ok = { matchThreshold: 75, storyWeight: 40, characterWeight: 30, dialogueWeight: 30, minMatchConfidence: 0.7 };
    expect(validateScoringConfig(ok)).toEqual([]);
    expect(validateScoringConfig({ ...ok, storyWeight: 50 })).toContainEqual(expect.stringMatching(/sum to 100/));
    expect(validateScoringConfig({ ...ok, storyWeight: -10, characterWeight: 80 })).toContainEqual(expect.stringMatching(/non-negative/));
    expect(validateScoringConfig({ ...ok, matchThreshold: 120 })).toContainEqual(expect.stringMatching(/between 0 and 100/));
    expect(() => new MatchingService({ embeddings: new ConceptEmbeddingService(), config: { storyWeight: 90 } })).toThrow(/sum to 100/);
  });

  it("threshold is configurable: the same evidence becomes PARTIAL above a stricter threshold", async () => {
    const r = await compare(HINDI_UTTERANCES, { config: { matchThreshold: 99.9 } });
    expect(r.match_status).toBe("PARTIAL");
    expect(r.eligible).toBe(false);
    expect(r.scoring_configuration.threshold).toBe(99.9);
  });

  it("high similarity with poor source data is not eligible (confidence gate)", async () => {
    const r = await compare(HINDI_UTTERANCES, { tx: { wordConfidence: 0.65, languageConfidence: 0.4 } });
    expect(r.overall_score).toBeGreaterThanOrEqual(75);
    expect(r.confidence).toBeLessThan(0.7);
    expect(r.eligible).toBe(false);
    expect(r.match_status).toBe("PARTIAL");
    expect(r.reasoning).toMatch(/confidence/i);
  });

  it("is deterministic for identical inputs and configuration", async () => {
    const a = await compare(HINDI_UTTERANCES);
    const b = await compare(HINDI_UTTERANCES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("generates the explanation from evidence (no LLM) and records the scoring configuration", async () => {
    const r = await compare(HINDI_UTTERANCES);
    expect(r.reasoning).toMatch(/^Story \d+\/100: \d+ of \d+ story events/);
    expect(r.scoring_configuration).toMatchObject({ scoring_version: "1.0", threshold: 75, min_match_confidence: 0.7, embedding: { provider: "demo-concepts" } });
  });
});

describe("Embeddings", () => {
  it("calibration maps raw cosine into 0..1 and is not a raw percentage", () => {
    const c = { floor: 0.5, ceil: 0.9 };
    expect(calibrate(0.3, c)).toBe(0);
    expect(calibrate(0.7, c)).toBeCloseTo(0.5);
    expect(calibrate(0.95, c)).toBe(1);
    expect(deriveCalibration([0.8, 0.85, 0.9], [0.2, 0.3, 0.4])).toEqual({ floor: 0.4, ceil: 0.85 });
    expect(deriveCalibration([0.3], [0.5])).toBeNull();
  });

  it("hash fallback is deterministic and lexical", async () => {
    const h = new HashEmbeddingService();
    const [a, b, c] = await h.embed(["the maid studies law", "the maid studies law", "cricket match tomorrow"]);
    expect(cosine(a, b)).toBeCloseTo(1, 10);
    expect(cosine(a, c)).toBeLessThan(0.3);
    expect(h.info.semantic).toBe(false);
  });
});
