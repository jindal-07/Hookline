// Orchestrates final script generation: eligibility gate → minimal payload → skill adapter →
// originality validation. Claude is used ONLY here (through the configured skill).
import { GENERATION_STATUS, SCRIPT_STATUS } from "@reelscript/shared";
import { permanent } from "../../utils/errors.js";
import { OriginalityValidator } from "./OriginalityValidator.js";
import { STANDALONE_REQUIREMENTS } from "./skillAdapters.js";
import { forbiddenNameWords, namesToAvoid, repairReusedNames } from "./NameRepair.js";

export class ScriptGenerationService {
  /** @param {{ adapter: import('./skillAdapters.js').SkillAdapter, embeddings?: object, includeTranscriptSummary?: boolean, includeAnalysisOutline?: boolean }} opts */
  constructor({ adapter, embeddings = null, includeTranscriptSummary = true, includeAnalysisOutline = true, originality = {} }) {
    Object.assign(this, { adapter, includeTranscriptSummary, includeAnalysisOutline });
    this.validator = new OriginalityValidator({ embeddings, options: originality });
  }

  /**
   * @param {{ storyDNA: object, screenplayAnalysis: object, transcriptSummary: object, generationOptions: object, matchResult: object, transcript?: object, videoId: string }} input
   * @returns {Promise<{ status: string, content: string|null, metadata: object, originality: object|null }>}
   */
  async generate({ storyDNA, screenplayAnalysis, transcriptSummary, generationOptions = {}, matchResult, transcript, videoId }) {
    // Defence in depth: the pipeline already gates on eligibility, but never generate without an approved match.
    if (!matchResult?.eligible) throw permanent("NOT_ELIGIBLE", "Script generation requires an approved (MATCHED) match result");
    const payload = this.buildPayload({ storyDNA, screenplayAnalysis, transcriptSummary, generationOptions });
    const out = await this.adapter.invoke(payload, { videoId });

    if (out.status !== "COMPLETED") {
      const status = out.status === "AWAITING_MANUAL" ? GENERATION_STATUS.AWAITING_MANUAL : GENERATION_STATUS.DISABLED;
      return { status, content: null, metadata: { ...out.metadata, payload_fields: Object.keys(payload) }, originality: null };
    }
    return this.finalize(out.content, { metadata: { ...out.metadata, payload_fields: Object.keys(payload) }, transcript, screenplayAnalysis, storyDNA, language: payload.generation_options.language });
  }

  /**
   * Standalone episode from the training dataset — not tied to one source video.
   * @param {{ brief: object, playbook: object, corpus: {lines, names, overlays}, scriptId: string }} input
   */
  async generateStandalone({ brief, playbook, corpus, scriptId }) {
    const payload = {
      task: "Write one original standalone episode script for short-form vertical video, guided by what worked in the team's best-performing videos.",
      brief,
      playbook,
      // Character names used in the dataset's videos: the originality check rejects any of them.
      avoid_names: namesToAvoid(corpus?.names),
    };
    const out = await this.adapter.invoke(payload, { videoId: `script-${scriptId}`, requirements: STANDALONE_REQUIREMENTS });
    if (out.status !== "COMPLETED") {
      return { status: out.status === "AWAITING_MANUAL" ? SCRIPT_STATUS.AWAITING_MANUAL : SCRIPT_STATUS.DISABLED, content: null, metadata: out.metadata, originality: null };
    }
    return this.finalizeStandalone(out.content, { corpus, metadata: out.metadata, language: brief?.language });
  }

  /** Originality of a standalone script against the whole dataset corpus (+ basic format checks). */
  async finalizeStandalone(content, { corpus, metadata = {}, language }) {
    const checked = await this.validateRepairingNames(content, corpusAsSource(corpus), language);
    const format = formatChecks(checked.content);
    return { status: checked.originality.passed ? SCRIPT_STATUS.COMPLETED : SCRIPT_STATUS.REJECTED, content: checked.content, metadata: { ...metadata, ...checked.metadata, format }, originality: checked.originality, title: format.title };
  }

  /** Validate an externally produced script (manual import) with the same rules. */
  async finalize(content, { metadata = {}, transcript, screenplayAnalysis, storyDNA, language }) {
    const source = { transcript, analysis: screenplayAnalysis, storyDna: storyDNA };
    const checked = await this.validateRepairingNames(content, source, language || storyDNA?.format?.language);
    return {
      status: checked.originality.passed ? GENERATION_STATUS.COMPLETED : GENERATION_STATUS.REJECTED,
      content: checked.content,
      metadata: { ...metadata, ...checked.metadata },
      originality: checked.originality,
    };
  }

  /**
   * Originality check; a reused source character name is fixed in place (renamed throughout the script) and the
   * script re-checked, instead of rejecting a script that is otherwise original. Renames go in metadata.renamed.
   */
  async validateRepairingNames(content, source, language) {
    let originality = await this.validator.validate(content, source);
    const reused = originality.metrics?.reused_names || [];
    if (!reused.length) return { content, originality, metadata: {} };
    const forbidden = forbiddenNameWords((source.analysis?.characters || []).map(c => c.label));
    const repaired = repairReusedNames(content, reused, { forbidden, language });
    if (!repaired.renames.length) return { content, originality, metadata: {} };
    originality = await this.validator.validate(repaired.content, source);
    return { content: repaired.content, originality, metadata: { renamed: repaired.renames.map(({ from, to }) => ({ from, to })) } };
  }

  /**
   * Minimal input: Story DNA always; an abstract outline of the analysis and a transcript summary
   * (never the raw transcript) only when enabled. Source names/lines stay out of the payload.
   */
  buildPayload({ storyDNA, screenplayAnalysis, transcriptSummary, generationOptions }) {
    // Verbatim source lines/phrases in the avoid list stay server-side (used by the originality check);
    // the skill is told the rule instead, so it is never primed with the source's dialogue.
    const avoid = (storyDNA.avoid || []).filter(a => !/^(line|phrase) "/.test(a));
    if ((storyDNA.avoid || []).length !== avoid.length) avoid.push("any of the source video's dialogue or distinctive phrases (checked automatically after generation)");
    const payload = {
      task: "Write an original short-form video script inspired by the narrative mechanics below.",
      story_dna: { ...storyDNA, avoid },
      generation_options: {
        format: generationOptions.format || "vertical short-form video script",
        target_duration_seconds: generationOptions.targetDurationSeconds || storyDNA.format?.duration_seconds || 60,
        language: generationOptions.language || storyDNA.format?.language || "en",
        audience: generationOptions.audience || null,
        notes: generationOptions.notes || null,
      },
    };
    if (this.includeAnalysisOutline && screenplayAnalysis) {
      payload.structure_outline = {
        scene_count: screenplayAnalysis.scenes.length,
        beats: screenplayAnalysis.scenes.map(s => ({ story_beat: s.story_beat, emotional_state: s.emotional_state, purpose: s.narrative_purpose })),
        hook_mechanism: screenplayAnalysis.hook.curiosity_mechanism,
      };
    }
    if (this.includeTranscriptSummary && transcriptSummary) payload.transcript_summary = transcriptSummary;
    return payload;
  }
}

/** Present the dataset corpus in the shape OriginalityValidator expects (no scene-paraphrase check: no single source). */
function corpusAsSource(corpus = {}) {
  return {
    transcript: { dialogue_segments: (corpus.lines || []).map(text => ({ text })), narration_segments: [], uncertain_segments: [] },
    analysis: { characters: (corpus.names || []).map(label => ({ label })), dialogue_moments: [], visual_storytelling: { text_overlays: (corpus.overlays || []).map(detail => ({ detail })) } },
    storyDna: null,
  };
}

const FRONTMATTER = /^---\s*\n[\s\S]*?\n---/;
/** Non-blocking structure checks against the skill's documented output format. */
export function formatChecks(content) {
  const text = String(content || "");
  const scenes = (text.match(/^##\s*Scene\s+\d+/gim) || []).length;
  const beats = (text.match(/^\s*\d+\.\s*\*\*Beat\s+\d+/gim) || []).length;
  const characters = /^##\s*(Main\s+)?Characters\b/im.test(text);
  const locations = /^##\s*Locations?\b/im.test(text);
  const title = text.match(/^#\s+(?:Episode\s+\d+:\s*)?(.+?)\s*(?:\[.*\])?\s*$/m)?.[1]?.trim() || null;
  return {
    title,
    scene_count: scenes,
    beat_candidates: beats,
    has_character_references: characters,
    has_location_references: locations,
    has_frontmatter: FRONTMATTER.test(text),
    warnings: [
      ...(scenes === 0 ? ["No '## Scene N - INT./EXT. ...' headings found"] : []),
      ...(beats && beats < 9 ? [`Only ${beats} beat candidates (the skill asks for at least 9)`] : []),
      ...(FRONTMATTER.test(text) ? ["Contains frontmatter (the skill forbids it)"] : []),
      ...(scenes && !characters ? ["No '## Main Characters' reference section"] : []),
      ...(scenes && !locations ? ["No '## Locations' reference section"] : []),
    ],
  };
}

/** Deterministic, non-verbatim transcript summary for the skill (counts and functions, not lines). */
export function summarizeTranscript(t) {
  if (!t) return null;
  return {
    language: t.language,
    duration_seconds: t.duration_seconds,
    speaker_count: t.speakers.filter(s => s.speaker_id !== "SPEAKER_UNKNOWN").length || (t.speakers.length ? 1 : 0),
    dialogue_share: t.stats.speech_ratio,
    has_narration: t.narration_segments.length > 0,
    question_count: t.important_statements.filter(s => s.reason === "question").length,
    reveal_count: t.important_statements.filter(s => s.reason === "reveal").length,
  };
}
