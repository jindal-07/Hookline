// Deterministic normalisation of AssemblyAI output — no LLM. Preserves original language and wording.
import { tokenize } from "../matching/text.js";

const UNCERTAIN_CONFIDENCE = 0.6;
const QUESTION = /[?？]|\b(kya|kyun|kyon|kaise|kaun|kahan|kab)\b|क्या|क्यों|कैसे|कौन|कहाँ|कहां|कब/i;
const REVEAL = /\b(actually|truth|secret|the reason|i never told|confess|finally|really)\b|सच|असल में|राज़|राज|बताना था|कभी नहीं बताया|सच्चाई/i;
const EMPHATIC = /!|！/;

const r3 = n => Math.round(n * 1000) / 1000;
const msToS = ms => (typeof ms === "number" ? r3(ms / 1000) : 0);
const speakerId = s => (s == null || s === "" ? "SPEAKER_UNKNOWN" : `SPEAKER_${String(s).toUpperCase()}`);

export class TranscriptNormalizer {
  constructor({ uncertainBelow = UNCERTAIN_CONFIDENCE } = {}) { this.uncertainBelow = uncertainBelow; }

  /**
   * @param {{ raw: object, sentences?: object[]|null, videoId: string }} input
   * @returns normalized transcript conforming to normalized-transcript.schema.json
   */
  async normalize({ raw, sentences = null, videoId }) {
    const duration = r3(Number(raw.audio_duration) || 0);
    // Prefer diarized utterances; fall back to sentences, then to a single block of text.
    let source = "utterances";
    let units = Array.isArray(raw.utterances) && raw.utterances.length ? raw.utterances : null;
    if (!units && Array.isArray(sentences) && sentences.length) { units = sentences; source = "sentences"; }
    if (!units && raw.text?.trim()) {
      const words = raw.words || [];
      units = [{ text: raw.text, start: words[0]?.start ?? 0, end: words.at(-1)?.end ?? (duration * 1000), confidence: raw.confidence, speaker: null }];
      source = "text";
    }
    units = (units || []).filter(u => String(u.text || "").trim());

    const segments = units.map((u, i) => ({
      segment_id: "",
      speaker_id: speakerId(u.speaker),
      start_time: msToS(u.start),
      end_time: Math.max(msToS(u.end), msToS(u.start)),
      text: String(u.text).trim(),
      confidence: typeof u.confidence === "number" ? r3(u.confidence) : null,
      kind: "dialogue",
      _i: i,
    })).sort((a, b) => a.start_time - b.start_time || a._i - b._i);

    // Narration evidence: one identified speaker across the whole video with no turn-taking
    // (voice-over / monologue). Mixed videos keep everything as dialogue — we don't guess.
    const speakerSet = new Set(segments.map(s => s.speaker_id));
    const singleVoice = speakerSet.size === 1 && !speakerSet.has("SPEAKER_UNKNOWN") && segments.length >= 1 && source === "utterances";
    for (const s of segments) {
      if (s.confidence !== null && s.confidence < this.uncertainBelow) s.kind = "uncertain";
      else if (singleVoice) s.kind = "narration";
    }

    let d = 0, n = 0, u = 0;
    for (const s of segments) {
      s.segment_id = s.kind === "dialogue" ? `DIALOGUE_${String(++d).padStart(3, "0")}` : s.kind === "narration" ? `NARRATION_${String(++n).padStart(3, "0")}` : `UNCERTAIN_${String(++u).padStart(3, "0")}`;
      delete s._i;
    }

    const speakers = [...speakerSet].map(id => {
      const own = segments.filter(s => s.speaker_id === id);
      return { speaker_id: id, segment_count: own.length, speaking_seconds: r3(own.reduce((t, s) => t + (s.end_time - s.start_time), 0)) };
    });

    const words = Array.isArray(raw.words) ? raw.words : [];
    const confs = words.map(w => w.confidence).filter(c => typeof c === "number");
    const meanConfidence = confs.length ? r3(confs.reduce((a, b) => a + b, 0) / confs.length) : (typeof raw.confidence === "number" ? r3(raw.confidence) : null);
    const speechSeconds = r3(segments.reduce((t, s) => t + (s.end_time - s.start_time), 0));
    const wordCount = words.length || segments.reduce((t, s) => t + tokenize(s.text).length, 0);

    return {
      video_id: String(videoId),
      language: raw.language_code || "unknown",
      language_confidence: typeof raw.language_confidence === "number" ? r3(raw.language_confidence) : null,
      duration_seconds: duration,
      speakers,
      dialogue_segments: segments.filter(s => s.kind === "dialogue"),
      narration_segments: segments.filter(s => s.kind === "narration"),
      uncertain_segments: segments.filter(s => s.kind === "uncertain"),
      important_statements: importantStatements(segments),
      repeated_phrases: repeatedPhrases(segments),
      stats: {
        word_count: wordCount,
        mean_confidence: meanConfidence,
        speech_seconds: speechSeconds,
        speech_ratio: duration > 0 ? r3(Math.min(1, speechSeconds / duration)) : 0,
      },
      source,
      diarized: source === "utterances",
      code_switching: Array.isArray(raw.language_detection_results?.code_switching_languages) && raw.language_detection_results.code_switching_languages.length > 1,
    };
  }
}

/** All usable segments (dialogue + narration), in time order. */
export function spokenSegments(t) {
  return [...(t.dialogue_segments || []), ...(t.narration_segments || [])].sort((a, b) => a.start_time - b.start_time);
}

function importantStatements(segments) {
  const out = [];
  const add = (s, reason) => { if (!out.some(o => o.segment_id === s.segment_id)) out.push({ segment_id: s.segment_id, reason }); };
  for (const s of segments) {
    if (s.kind === "uncertain") continue;
    if (REVEAL.test(s.text)) add(s, "reveal");
    else if (QUESTION.test(s.text)) add(s, "question");
    else if (EMPHATIC.test(s.text)) add(s, "emphatic");
  }
  // The longest few statements usually carry the most information.
  [...segments].filter(s => s.kind !== "uncertain").sort((a, b) => b.text.length - a.text.length).slice(0, 3).forEach(s => add(s, "substantive"));
  return out;
}

function repeatedPhrases(segments, { minN = 2, maxN = 5, minCount = 2, limit = 15 } = {}) {
  const counts = new Map();
  for (const s of segments) {
    const toks = tokenize(s.text);
    const seenInSeg = new Set();
    for (let n = minN; n <= maxN; n++)
      for (let i = 0; i + n <= toks.length; i++) {
        const p = toks.slice(i, i + n).join(" ");
        if (p.length < 6 || seenInSeg.has(p)) continue;
        seenInSeg.add(p);
        counts.set(p, (counts.get(p) || 0) + 1);
      }
  }
  // Keep the longest phrases; drop sub-phrases of an equally frequent longer phrase.
  const items = [...counts].filter(([, c]) => c >= minCount).sort((a, b) => b[0].split(" ").length - a[0].split(" ").length || b[1] - a[1]);
  const kept = [];
  for (const [phrase, count] of items) {
    if (kept.some(k => k.count >= count && k.phrase.includes(phrase))) continue;
    kept.push({ phrase, count });
    if (kept.length >= limit) break;
  }
  return kept.sort((a, b) => b.count - a.count);
}
