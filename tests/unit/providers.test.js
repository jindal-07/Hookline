// Provider adapters tested against fake SDK clients — no network, no paid calls.
import { describe, it, expect } from "vitest";
import { AssemblyAITranscriber } from "../../server/src/services/transcription/AssemblyAITranscriber.js";
import { TranscriptNormalizer } from "../../server/src/services/normalization/TranscriptNormalizer.js";
import { GeminiVideoAnalyzer } from "../../server/src/services/screenplay/GeminiVideoAnalyzer.js";
import { normalizeScreenplay, mergeChunkAnalyses } from "../../server/src/services/screenplay/ScreenplayNormalizer.js";
import { validate } from "../../server/src/utils/schema.js";
import { baseScreenplay, rawTranscript, HINDI_UTTERANCES } from "../fixtures/matching.js";

describe("AssemblyAITranscriber", () => {
  const fakeClient = (result, { sentences = [], onParams } = {}) => ({
    transcripts: {
      transcribe: async (params, opts) => { onParams?.(params, opts); return typeof result === "function" ? result() : result; },
      sentences: async () => ({ sentences }),
    },
  });

  it("requests diarization, language detection with code switching and the configured speech models", async () => {
    let seen;
    const t = new AssemblyAITranscriber({ client: fakeClient({ ...rawTranscript(HINDI_UTTERANCES), speech_model_used: "universal-3-5-pro" }, { onParams: (p) => { seen = p; } }), speechModels: ["universal-3-5-pro", "universal-2"], expectedLanguages: ["hi", "en"] });
    const r = await t.transcribe("a.flac");
    expect(seen).toMatchObject({ audio: "a.flac", speaker_labels: true, language_detection: true, speech_models: ["universal-3-5-pro", "universal-2"], language_detection_options: { expected_languages: ["hi", "en"], code_switching: true } });
    expect(seen.language_code).toBeUndefined(); // never forces a language (no translation)
    expect(r.metadata).toMatchObject({ provider: "assemblyai", language_code: "hi", speech_model_used: "universal-3-5-pro", diarization_available: true });
  });

  it("classifies provider errors: audio problems are permanent, service errors transient", async () => {
    const bad = new AssemblyAITranscriber({ client: fakeClient({ status: "error", error: "File does not appear to contain audio" }) });
    await expect(bad.transcribe("a")).rejects.toMatchObject({ code: "TRANSCRIPTION_REJECTED", permanent: true });
    const flaky = new AssemblyAITranscriber({ client: fakeClient({ status: "error", error: "Internal server error, please retry" }) });
    await expect(flaky.transcribe("a")).rejects.toMatchObject({ code: "TRANSCRIPTION_FAILED", permanent: false });
    const auth = new AssemblyAITranscriber({ client: fakeClient(() => { throw Object.assign(new Error("Unauthorized"), { status: 401 }); }) });
    await expect(auth.transcribe("a")).rejects.toMatchObject({ code: "PROVIDER_AUTH", permanent: true });
  });

  it("refuses to construct without an API key", () => {
    expect(() => new AssemblyAITranscriber({})).toThrow(/ASSEMBLYAI_API_KEY/);
  });
});

describe("TranscriptNormalizer", () => {
  const norm = (raw, sentences) => new TranscriptNormalizer().normalize({ raw, sentences, videoId: "v1" });

  it("converts ms to seconds, keeps original wording and produces a schema-valid transcript", async () => {
    const t = await norm(rawTranscript(HINDI_UTTERANCES));
    expect(validate("transcript", t).valid).toBe(true);
    expect(t.dialogue_segments[0]).toMatchObject({ segment_id: "DIALOGUE_001", speaker_id: "SPEAKER_A", start_time: 2, end_time: 6, text: "अनुच्छेद इक्कीस जीवन और स्वतंत्रता का अधिकार" });
    expect(t.speakers.map(s => s.speaker_id).sort()).toEqual(["SPEAKER_A", "SPEAKER_B", "SPEAKER_C"]);
    expect(t.language).toBe("hi");
    expect(t.important_statements.some(s => s.reason === "question")).toBe(true);
  });

  it("marks low-confidence segments uncertain instead of guessing", async () => {
    const raw = rawTranscript(HINDI_UTTERANCES);
    raw.utterances[1].confidence = 0.4;
    const t = await norm(raw);
    expect(t.uncertain_segments).toHaveLength(1);
    expect(t.uncertain_segments[0].kind).toBe("uncertain");
  });

  it("treats a single diarized voice as narration, and falls back to sentences without diarization", async () => {
    const mono = rawTranscript([{ speaker: "A", start: 0, end: 4000, text: "यह कहानी एक गाँव की है" }, { speaker: "A", start: 5000, end: 9000, text: "जहाँ हर कोई सपने देखता था" }]);
    expect((await norm(mono)).narration_segments).toHaveLength(2);
    const nodiar = rawTranscript(HINDI_UTTERANCES, { diarized: false });
    const t = await norm(nodiar, nodiar.__sentences);
    expect(t.diarized).toBe(false);
    expect(t.dialogue_segments.every(s => s.speaker_id === "SPEAKER_UNKNOWN")).toBe(true);
  });

  it("finds repeated phrases and handles empty audio", async () => {
    const rep = rawTranscript([{ speaker: "A", start: 0, end: 2000, text: "मुझे माफ़ कर दो माँ" }, { speaker: "B", start: 3000, end: 5000, text: "नहीं" }, { speaker: "A", start: 6000, end: 8000, text: "मुझे माफ़ कर दो माँ प्लीज़" }]);
    expect((await norm(rep)).repeated_phrases[0]).toMatchObject({ phrase: "मुझे माफ़ कर दो माँ", count: 2 });
    const empty = await norm({ audio_duration: 0, utterances: [], words: [], language_code: null });
    expect(empty).toMatchObject({ language: "unknown", dialogue_segments: [], stats: { word_count: 0, speech_ratio: 0 } });
  });
});

describe("GeminiVideoAnalyzer — response validation", () => {
  const fakeAi = (responses) => {
    const calls = [];
    return {
      calls,
      files: {
        upload: async () => ({ name: "files/1", uri: "gs://x", mimeType: "video/mp4", state: "ACTIVE" }),
        get: async () => ({ state: "ACTIVE" }),
        delete: async () => { calls.push("delete"); },
      },
      models: {
        generateContent: async (req) => {
          calls.push(req);
          const r = responses.shift();
          if (r instanceof Error) throw r;
          return { text: r, usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 } };
        },
      },
    };
  };
  const analyzer = (ai) => new GeminiVideoAnalyzer({ client: ai, model: "gemini-test", maxValidationRetries: 2, workDir: "tests/.tmp" });

  it("requests JSON with the screenplay schema and returns validated output", async () => {
    const ai = fakeAi([JSON.stringify(baseScreenplay())]);
    const r = await analyzer(ai).analyzeVideo("v.mp4", { videoId: "v", durationSeconds: 60 });
    expect(ai.calls[0].config).toMatchObject({ responseMimeType: "application/json" });
    expect(ai.calls[0].config.responseJsonSchema.title).toBe("ScreenplayAnalysis");
    expect(r.metadata).toMatchObject({ model: "gemini-test", attempts: 1, usage: { prompt_tokens: 1000, output_tokens: 200 } });
    expect(ai.calls.at(-1)).toBe("delete"); // uploaded file cleaned up
  });

  it("retries malformed or schema-invalid responses, feeding the errors back", async () => {
    const ai = fakeAi(["{not json", JSON.stringify({ scenes: [] }), "```json\n" + JSON.stringify(baseScreenplay()) + "\n```"]);
    const r = await analyzer(ai).analyzeVideo("v.mp4", { videoId: "v", durationSeconds: 60 });
    expect(r.metadata.attempts).toBe(3);
    const lastPrompt = ai.calls[2].contents.parts.at(-1).text;
    expect(lastPrompt).toMatch(/previous response was rejected/);
  });

  it("gives up with a retryable ANALYSIS_INVALID error instead of crashing the batch", async () => {
    const ai = fakeAi(["nope", "still nope", "{}"]);
    await expect(analyzer(ai).analyzeVideo("v.mp4", { videoId: "v", durationSeconds: 60 })).rejects.toMatchObject({ code: "ANALYSIS_INVALID", permanent: false });
    expect(ai.calls.at(-1)).toBe("delete");
  });

  it("classifies API errors", async () => {
    const ai = fakeAi([Object.assign(new Error("RESOURCE_EXHAUSTED: quota"), { status: 429 })]);
    await expect(analyzer(ai).analyzeVideo("v.mp4", { videoId: "v", durationSeconds: 60 })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT", permanent: false });
  });
});

describe("ScreenplayNormalizer", () => {
  it("clamps times, orders scenes, drops dangling references and records repairs", () => {
    const a = baseScreenplay();
    a.scenes.reverse();
    a.scenes[0].end_time = 999;
    a.scenes[1].characters.push("CHAR_999");
    const { analysis, repairs, evidence } = normalizeScreenplay(a, { durationSeconds: 60 });
    expect(analysis.scenes.map(s => s.scene_id)).toEqual(["SCENE_001", "SCENE_002", "SCENE_003"]);
    expect(analysis.scenes[0].start_time).toBe(0);
    expect(analysis.scenes.every(s => s.end_time <= 60)).toBe(true);
    expect(analysis.scenes.flatMap(s => s.characters)).not.toContain("CHAR_999");
    expect(repairs.length).toBeGreaterThanOrEqual(2);
    expect(evidence).toMatchObject({ scene_count: 3, character_count: 3, has_dialogue: true });
    expect(validate("screenplay", analysis).valid).toBe(true);
  });

  it("merges chunk analyses of long videos with absolute timestamps", () => {
    const merged = mergeChunkAnalyses([{ offset: 0, analysis: baseScreenplay() }, { offset: 60, analysis: baseScreenplay() }], 120);
    expect(merged.scenes).toHaveLength(6);
    expect(merged.scenes[3].start_time).toBe(60);
    expect(merged.characters).toHaveLength(3); // same labels merged
    expect(validate("screenplay", merged).valid).toBe(true);
  });
});
