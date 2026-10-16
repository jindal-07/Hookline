// MatchingService — deterministic transcript ↔ screenplay consistency scoring.
// No LLM is involved: scores come from structured-field comparison, semantic embeddings,
// timestamp alignment, explicit contradiction/missing-evidence penalties and evidence-quality confidence.
import { MATCH_STATUS, SCORING_VERSION, DEFAULT_SCORING } from "@reelscript/shared";
import { spokenSegments } from "../normalization/TranscriptNormalizer.js";
import { buildWindows, round3 } from "./align.js";
import { scoreStory, scoreCharacters, scoreDialogue, mapSpeakers } from "./dimensions.js";
import { scriptOf } from "./text.js";
import { validate } from "../../utils/schema.js";

export const MIN_WORDS = 8;
export const INCONCLUSIVE_CONFIDENCE = 0.35;
export const MISMATCH_BELOW = 40;

/** Validate a scoring configuration: weights non-negative and summing to 100, threshold 0–100, confidence 0–1. */
export function validateScoringConfig(c) {
  const errors = [];
  for (const k of ["storyWeight", "characterWeight", "dialogueWeight"]) {
    if (!Number.isFinite(c[k]) || c[k] < 0) errors.push(`${k} must be a non-negative number`);
  }
  const sum = (c.storyWeight ?? 0) + (c.characterWeight ?? 0) + (c.dialogueWeight ?? 0);
  if (Math.abs(sum - 100) > 1e-9) errors.push(`weights must sum to 100 (got ${sum})`);
  if (!Number.isFinite(c.matchThreshold) || c.matchThreshold < 0 || c.matchThreshold > 100) errors.push("matchThreshold must be between 0 and 100");
  if (!Number.isFinite(c.minMatchConfidence) || c.minMatchConfidence < 0 || c.minMatchConfidence > 1) errors.push("minMatchConfidence must be between 0 and 1");
  if (c.contradictionPenalty !== undefined && (!Number.isFinite(c.contradictionPenalty) || c.contradictionPenalty < 0 || c.contradictionPenalty > 50)) errors.push("contradictionPenalty must be between 0 and 50");
  return errors;
}

export class MatchingService {
  /** @param {{ embeddings: import('../embeddings/EmbeddingService.js').EmbeddingService, config?: object }} opts */
  constructor({ embeddings, config = {} }) {
    this.embeddings = embeddings;
    this.config = { ...DEFAULT_SCORING, contradictionPenalty: 5, maxPenaltyPerDimension: 25, ...config };
    const errs = validateScoringConfig(this.config);
    if (errs.length) throw new Error(`Invalid scoring configuration: ${errs.join("; ")}`);
  }

  async compare({ transcript, screenplayAnalysis, videoId, config: override } = {}) {
    const cfg = override ? { ...this.config, ...override } : this.config;
    const errs = validateScoringConfig(cfg);
    if (errs.length) throw new Error(`Invalid scoring configuration: ${errs.join("; ")}`);
    const info = this.embeddings.info;
    const scoringConfiguration = {
      scoring_version: SCORING_VERSION,
      threshold: cfg.matchThreshold,
      weights: { story: cfg.storyWeight, character: cfg.characterWeight, dialogue: cfg.dialogueWeight },
      min_match_confidence: cfg.minMatchConfidence,
      contradiction_penalty: cfg.contradictionPenalty,
      embedding: { provider: info.provider, model: info.model, version: info.version, semantic: info.semantic, multilingual: info.multilingual, calibration: info.calibration },
    };
    const id = String(videoId ?? transcript?.video_id ?? "unknown");
    const T = transcript, S = screenplayAnalysis;

    // ---------- inconclusive pre-checks (missing evidence is never treated as a match) ----------
    const reasons = [];
    if (!S) reasons.push("screenplay_missing");
    else if (!validate("screenplay", S).valid) reasons.push("screenplay_malformed");
    if (!T) reasons.push("transcript_missing");
    if (reasons.length) return this.inconclusive(id, reasons, scoringConfiguration, { confidence: 0 });

    const spoken = spokenSegments(T);
    const words = T.stats?.word_count ?? 0;
    const screenplayHasDialogue = S.dialogue_moments.length > 0 || S.scenes.some(s => s.dialogue_summary?.trim());
    if (!spoken.length || words < MIN_WORDS) {
      reasons.push(screenplayHasDialogue ? "transcript_empty_or_incomplete" : "little_or_no_speech");
      return this.inconclusive(id, reasons, scoringConfiguration, { confidence: 0, notes: { words, spoken_segments: spoken.length } });
    }
    if (T.stats?.mean_confidence !== null && T.stats?.mean_confidence !== undefined && T.stats.mean_confidence < 0.5)
      reasons.push("low_transcription_confidence");
    // Transcript covers too little of the video, or misses most of the dialogue the screenplay describes.
    const vidDur = S.metadata.duration_seconds || T.duration_seconds;
    if (T.duration_seconds && vidDur && T.duration_seconds < vidDur * 0.5) reasons.push("transcript_incomplete");
    // Cross-language comparison needs a multilingual semantic embedding model.
    const tScript = scriptOf(spoken.map(s => s.text).join(" "));
    const sScript = scriptOf([...S.scenes.map(s => s.visual_description), ...S.dialogue_moments.map(m => m.summary)].join(" "));
    const crossScript = tScript !== sScript && tScript !== "mixed" && sScript !== "mixed" && tScript !== "none" && sScript !== "none";
    if (crossScript && !info.multilingual) reasons.push("language_incompatible");

    // ---------- embed every text once (batch; cached by the embedding service) ----------
    const windows = buildWindows(spoken);
    const texts = new Set(windows.map(w => w.text));
    for (const s of spoken) texts.add(s.text);
    for (const b of S.narrative_beats) texts.add(b.description);
    for (const sc of S.scenes) { texts.add([sc.visual_description, ...sc.actions].join(". ")); if (sc.dialogue_summary) texts.add(sc.dialogue_summary); }
    for (const e of S.story_structure) if (e.description) texts.add(e.description);
    for (const m of S.dialogue_moments) texts.add(m.summary);
    const byId = Object.fromEntries(S.characters.map(c => [c.character_id, c]));
    for (const c of S.characters) texts.add([`${c.label}: ${c.role}.`, c.motivation, c.key_actions.slice(0, 4).join("; "), c.relationships.map(r => `${r.relationship} of ${byId[r.character_id]?.label || r.character_id}`).join("; ")].filter(Boolean).join(" "));
    const speakerIds = [...new Set(spoken.map(s => s.speaker_id))];
    for (const spk of speakerIds) texts.add(spoken.filter(s => s.speaker_id === spk).map(s => s.text).join(" ").slice(0, 2000));
    texts.add(spoken.map(s => s.text).join(" ").slice(0, 2000));
    const list = [...texts].filter(t => t && t.trim());
    const vectors = await this.embeddings.embed(list);
    const vecMap = new Map(list.map((t, i) => [t, vectors[i]]));
    const vecOf = (t) => vecMap.get(t) || vecMap.get(String(t).trim()) || new Array(vectors[0]?.length || 1).fill(0);

    const ctx = { S, T, spoken, windows, vecOf, cal: info.calibration, codeSwitching: !!T.code_switching };

    // ---------- dimensions ----------
    const story = scoreStory(ctx);
    const mapping = mapSpeakers(ctx);
    const character = scoreCharacters(ctx, mapping);
    const dialogue = scoreDialogue(ctx);

    // Dialogue moments with no speech nearby → transcript probably incomplete
    if (dialogue.counts.moments >= 3 && dialogue.counts.with_speech_nearby / dialogue.counts.moments < 0.4) reasons.push("transcript_incomplete");
    if (story.score === null) reasons.push("story_not_evaluable");
    if (dialogue.score === null) reasons.push("dialogue_not_evaluable");
    if (character.score === null) reasons.push("characters_not_evaluable");

    // ---------- contradiction penalties ----------
    const penal = (score, n) => (score === null ? null : Math.max(0, score - Math.min(cfg.maxPenaltyPerDimension, n * cfg.contradictionPenalty)));
    const storyScore = penal(story.score, story.contradictions);
    const characterScore = penal(character.score, character.contradictions);
    const dialogueScore = penal(dialogue.score, dialogue.contradictions);

    const overall = [storyScore, characterScore, dialogueScore].some(s => s === null)
      ? null
      : (storyScore * cfg.storyWeight + characterScore * cfg.characterWeight + dialogueScore * cfg.dialogueWeight) / 100;

    // ---------- confidence = evidence quality (not similarity) ----------
    const confidenceFactors = this.confidenceFactors({ T, S, spoken, words, story, mapping, info, crossScript });
    const confidence = evidenceConfidence(confidenceFactors);

    const evidence = {
      story_matches: story.evidence.matches,
      character_matches: character.evidence.matches,
      dialogue_matches: dialogue.evidence.matches,
      mismatches: [...story.evidence.mismatches, ...character.evidence.mismatches, ...dialogue.evidence.mismatches],
      uncertain_elements: [...story.evidence.uncertain, ...character.evidence.uncertain, ...dialogue.evidence.uncertain],
      components: { story: story.components, character: character.components, dialogue: dialogue.components },
      counts: { story: story.counts, character: character.counts, dialogue: dialogue.counts },
      penalties: {
        story: round3((story.score ?? 0) - (storyScore ?? 0)),
        character: round3((character.score ?? 0) - (characterScore ?? 0)),
        dialogue: round3((dialogue.score ?? 0) - (dialogueScore ?? 0)),
      },
      confidence_factors: Object.fromEntries(Object.entries(confidenceFactors).map(([k, [v]]) => [k, round3(v)])),
    };

    // ---------- status + eligibility ----------
    let status;
    const uniqueReasons = [...new Set(reasons)];
    if (uniqueReasons.length || overall === null) status = MATCH_STATUS.INCONCLUSIVE;
    else if (confidence < INCONCLUSIVE_CONFIDENCE) { status = MATCH_STATUS.INCONCLUSIVE; uniqueReasons.push("insufficient_evidence_quality"); }
    else if (overall < MISMATCH_BELOW || evidence.mismatches.length >= 4) status = MATCH_STATUS.MISMATCHED;
    else if (overall >= cfg.matchThreshold && confidence >= cfg.minMatchConfidence) status = MATCH_STATUS.MATCHED;
    else status = MATCH_STATUS.PARTIAL;

    const result = {
      video_id: id,
      overall_score: overall,
      story_score: storyScore,
      character_score: characterScore,
      dialogue_score: dialogueScore,
      confidence,
      match_status: status,
      eligible: status === MATCH_STATUS.MATCHED,
      evidence,
      inconclusive_reasons: uniqueReasons,
      reasoning: "",
      scoring_version: SCORING_VERSION,
      scoring_configuration: scoringConfiguration,
    };
    result.reasoning = explain(result, { story, character, dialogue, mapping, cfg, info });
    return result;
  }

  confidenceFactors({ T, S, spoken, words, story, mapping, info, crossScript }) {
    const speakers = new Set(spoken.map(s => s.speaker_id));
    const diarization = !T.diarized ? 0.6 : (speakers.size >= 2 || (T.narration_segments || []).length) ? 1 : 0.9;
    const mappingConf = mapping.evaluable && Object.keys(mapping.confidence).length
      ? Object.values(mapping.confidence).reduce((a, b) => a + b, 0) / Object.keys(mapping.confidence).length
      : 0.6;
    const analysisEvidence = Math.min(1, (S.narrative_beats.length + S.dialogue_moments.length + S.scenes.length) / 8);
    const evaluable = story.counts.events ? Math.max(0.3, story.counts.evaluable / story.counts.events) : 0.5;
    const embeddingQ = !info.semantic ? (crossScript ? 0.25 : 0.55) : 1;
    // [value, weight]
    return {
      transcription_confidence: [clamp01(T.stats?.mean_confidence ?? 0.75), 2],
      language_confidence: [clamp01(T.language_confidence ?? 0.8), 1],
      speech_amount: [clamp01(words / 50), 1.5],
      diarization: [diarization, 1],
      speaker_mapping: [clamp01(Math.max(0.3, mappingConf)), 1],
      analysis_evidence: [clamp01(Math.max(0.2, analysisEvidence)), 1],
      evaluable_events: [evaluable, 1],
      embedding_quality: [embeddingQ, 1.5],
    };
  }

  inconclusive(videoId, reasons, scoringConfiguration, { confidence = 0, notes } = {}) {
    const result = {
      video_id: videoId,
      overall_score: null, story_score: null, character_score: null, dialogue_score: null,
      confidence,
      match_status: MATCH_STATUS.INCONCLUSIVE,
      eligible: false,
      evidence: { story_matches: [], character_matches: [], dialogue_matches: [], mismatches: [], uncertain_elements: notes ? [{ type: "precheck", ...notes }] : [] },
      inconclusive_reasons: reasons,
      reasoning: "",
      scoring_version: SCORING_VERSION,
      scoring_configuration: scoringConfiguration,
    };
    result.reasoning = `Inconclusive: ${reasons.map(r => REASON_TEXT[r] || r).join("; ")}. No match score was assigned and the video was not sent for script generation.`;
    return result;
  }
}

const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
/**
 * Evidence-quality confidence: half weighted geometric mean, half weakest factor.
 * The weakest-link term stops one very poor input (e.g. 40% language confidence) from being averaged away.
 */
function evidenceConfidence(factors) {
  let s = 0, w = 0, min = 1;
  for (const [v, weight] of Object.values(factors)) { s += Math.log(Math.max(1e-6, v)) * weight; w += weight; min = Math.min(min, v); }
  const gm = w ? Math.exp(s / w) : 0;
  return 0.5 * gm + 0.5 * min;
}

export const REASON_TEXT = {
  screenplay_missing: "the screenplay analysis is missing",
  screenplay_malformed: "the screenplay analysis does not match the required structure",
  transcript_missing: "the transcript is missing",
  transcript_empty_or_incomplete: "the screenplay describes dialogue but the transcript is empty or nearly empty",
  little_or_no_speech: "the video has little or no speech, so dialogue matching is not meaningful",
  low_transcription_confidence: "transcription confidence is too low to compare reliably",
  transcript_incomplete: "the transcript covers too little of the video or misses most of the described dialogue",
  language_incompatible: "the transcript and analysis are in different languages/scripts and the configured embedding model is not multilingual",
  story_not_evaluable: "no story events could be compared with the speech",
  dialogue_not_evaluable: "the screenplay contains no dialogue to compare",
  characters_not_evaluable: "characters could not be compared",
  insufficient_evidence_quality: "the evidence is too weak (low confidence) to trust the scores",
};

/** Human-readable explanation generated from the structured evidence (no LLM). */
function explain(r, { story, character, dialogue, mapping, cfg, info }) {
  const f = n => (n === null ? "n/a" : Math.round(n));
  const parts = [];
  parts.push(`Story ${f(r.story_score)}/100: ${story.counts.supported} of ${story.counts.evaluable} story events that occur during speech are reflected in the transcript` +
    (story.components.order !== null ? `, with event-order concordance ${story.components.order}` : "") +
    (story.counts.events - story.counts.evaluable > 0 ? `; ${story.counts.events - story.counts.evaluable} visual-only events were not scored` : "") + ".");
  parts.push(mapping.evaluable
    ? `Characters ${f(r.character_score)}/100: ${character.counts.mapped} of ${character.counts.speakers} transcript speakers mapped to screenplay characters (${character.counts.speaking_characters} speaking characters).`
    : `Characters ${f(r.character_score)}/100: speaker identities are uncertain (${mapping.reason?.toLowerCase() || "no mapping"}), so only role alignment was scored.`);
  parts.push(`Dialogue ${f(r.dialogue_score)}/100: ${dialogue.counts.supported ?? 0} of ${dialogue.counts.moments ?? 0} key dialogue moments are supported by what is said.`);
  if (r.evidence.mismatches.length) parts.push(`${r.evidence.mismatches.length} contradiction(s): ${r.evidence.mismatches.slice(0, 3).map(m => m.note).join(" ")}`);
  parts.push(`Confidence ${round3(r.confidence)} reflects evidence quality (transcription ${r.evidence.confidence_factors?.transcription_confidence ?? "n/a"}, speech amount, diarization, ${info.semantic ? "semantic" : "lexical fallback"} embeddings).`);
  if (r.match_status === MATCH_STATUS.MATCHED) parts.push(`Overall ${f(r.overall_score)} meets the threshold of ${cfg.matchThreshold} with sufficient confidence — eligible for script generation.`);
  else if (r.match_status === MATCH_STATUS.PARTIAL) parts.push(r.overall_score >= cfg.matchThreshold
    ? `Overall ${f(r.overall_score)} meets the threshold, but confidence ${round3(r.confidence)} is below the required ${cfg.minMatchConfidence} — flagged for review, not generated.`
    : `Overall ${f(r.overall_score)} is below the threshold of ${cfg.matchThreshold} — generation skipped.`);
  else if (r.match_status === MATCH_STATUS.MISMATCHED) parts.push(`Overall ${f(r.overall_score)}: the transcript and screenplay disagree — generation skipped.`);
  else parts.push(`Inconclusive: ${r.inconclusive_reasons.map(x => REASON_TEXT[x] || x).join("; ")}.`);
  return parts.join(" ");
}
