// Helpers for training videos imported with an existing transcript + screenplay (text) instead of being
// downloaded and analysed: encoding repair, duration parsing, and transcript reconstruction. Deterministic, no LLM.

// UTF-8 punctuation that was decoded as Mac Roman / Windows-1252 somewhere along the way (e.g. ’ → ‚Äô).
const MOJIBAKE = [
  ["‚Äô", "’"], ["‚Äò", "‘"], ["‚Äú", "“"], ["‚Äù", "”"], ["‚Äî", "—"], ["‚Äì", "–"], ["‚Ä¶", "…"], ["‚Ä¢", "•"], ["¬†", " "],
  ["â€™", "’"], ["â€˜", "‘"], ["â€œ", "“"], ["â€\u009d", "”"], ["â€”", "—"], ["â€“", "–"], ["â€¦", "…"], ["Â ", " "],
];

/** Repairs common mis-decoded punctuation; leaves everything else (incl. Hindi) untouched. */
export function fixMojibake(s) {
  let out = String(s ?? "");
  for (const [bad, good] of MOJIBAKE) if (out.includes(bad)) out = out.split(bad).join(good);
  return out;
}

const TIME = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const toSeconds = (m) => (m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]));

/** 75 | "75" | "1:15" | "01:15" | "1m 15s" | "2 min" → seconds; null when not parseable. */
export function parseDuration(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw < 1 ? raw * 86400 : raw) : null; // Excel time cells are day fractions
  const s = String(raw).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s)) || null;
  const t = s.match(new RegExp(`^${TIME.source}$`));
  if (t) return toSeconds(t) || null;
  const m = s.match(/^(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?$/);
  if (m && (m[1] || m[2])) return Math.round((parseFloat(m[1] || 0) * 60) + parseFloat(m[2] || 0)) || null;
  return null;
}

/** Latest timestamp in a timestamped screenplay ("[03:10 - 05:02]" → 302), or null. */
export function screenplayDuration(text) {
  let max = 0;
  for (const m of String(text || "").matchAll(new RegExp(TIME.source, "g"))) max = Math.max(max, toSeconds(m));
  return max || null;
}

const NAME_LINE = /^([A-Z][A-Z0-9 .'’-]{0,40}?)(?:\s*\((?:V\.?O\.?|O\.?S\.?|CONT'D|CONT’D|[^)]*)\))?\s*:?\s*$/;
const SCENE_HEADING = /^(\*\*)?\s*(\[[^\]]*\]\s*)?(INT\.|EXT\.|INT\/EXT|I\/E|FADE|CUT TO|DISSOLVE|SMASH|TITLE|SUPER|LOGLINE|PRODUCTION NOTES|THE END)/i;
const isParenthetical = (l) => /^\(.*\)$/.test(l);

/** Dialogue lines from a screenplay: a CHARACTER line followed by the lines spoken, until a blank line. */
export function dialogueFromScreenplay(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(l => l.replace(/\*\*/g, "").trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || SCENE_HEADING.test(l)) continue;
    const name = l.match(NAME_LINE);
    if (!name || !/[A-Z]/.test(name[1]) || name[1].split(" ").length > 4) continue;
    const spoken = [];
    let j = i + 1;
    for (; j < lines.length && lines[j]; j++) {
      if (SCENE_HEADING.test(lines[j]) || NAME_LINE.test(lines[j])) break;
      if (!isParenthetical(lines[j])) spoken.push(lines[j]);
    }
    if (spoken.length) out.push({ speaker: name[1].trim(), text: spoken.join(" ") });
    i = j - 1;
  }
  return out;
}

const SPEAKER_PREFIX = /^\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–—]?\s*)?(?:([^:\n]{1,40}?)\s*:\s+)?(.+)$/;

/** Turns of a plain-text transcript: optional "[mm:ss]" / "NAME:" prefixes; otherwise one turn per line. */
export function turnsFromTranscript(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 1 && !/^\[?\d{1,2}:\d{2}/.test(lines[0]) && !/^[^:\n]{1,40}:\s/.test(lines[0])) {
    // One paragraph (typical speech-to-text export): split into sentences so matching has units to work with.
    return lines[0].split(/(?<=[.!?।])\s+/).filter(Boolean).map(t => ({ text: t, speaker: null, time: null }));
  }
  return lines.map(l => {
    const m = l.match(SPEAKER_PREFIX);
    const speaker = m?.[2] && !/https?$/i.test(m[2]) && m[2].split(" ").length <= 4 ? m[2].trim() : null;
    return { text: (speaker ? m[3] : l.replace(/^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*[-–—]?\s*/, "")).trim(), speaker, time: m?.[1] ? toSeconds(m[1].match(TIME)) : null };
  }).filter(t => t.text);
}

const HINGLISH = /\b(hai|hain|nahi|nahin|kya|kyun|main|mein|tum|aap|hum|mera|meri|tera|teri|kar|karo|raha|rahi|tha|thi|bhai|yaar|accha|achha|haan|bas|matlab)\b/gi;

/** "hi" for Devanagari or clearly Hinglish text, "en" otherwise. */
export function guessLanguage(text) {
  const s = String(text || "");
  if (/[ऀ-ॿ]/.test(s)) return "hi";
  const words = s.split(/\s+/).length || 1;
  return (s.match(HINGLISH) || []).length / words > 0.04 ? "hi" : "en";
}

/**
 * Raw transcript in the shape TranscriptNormalizer expects (AssemblyAI-like, times in ms), built from the
 * imported transcript text — or, when there is none, from the screenplay's dialogue. Without timestamps,
 * turns are spread evenly across the video.
 */
export function rawTranscriptFromText({ transcript, screenplay, durationSeconds }) {
  const fromTranscript = transcript && transcript.trim() ? turnsFromTranscript(transcript) : [];
  const turns = fromTranscript.length ? fromTranscript : dialogueFromScreenplay(screenplay).map(d => ({ ...d, time: null }));
  const duration = durationSeconds || null;
  const span = duration || Math.max(1, turns.length * 3);
  const step = span / Math.max(1, turns.length);
  const speakers = [...new Set(turns.map(t => t.speaker).filter(Boolean))];
  const speakerKey = (name) => (name ? String.fromCharCode(65 + (speakers.indexOf(name) % 26)) : null);
  const utterances = turns.map((t, i) => {
    const start = t.time ?? i * step;
    const next = turns[i + 1]?.time ?? (i + 1) * step;
    return { text: t.text, start: Math.round(start * 1000), end: Math.round(Math.max(start + 0.5, Math.min(next, span)) * 1000), confidence: null, speaker: speakerKey(t.speaker), speaker_name: t.speaker };
  });
  const text = turns.map(t => t.text).join(" ");
  return {
    raw: {
      audio_duration: span,
      utterances: speakers.length ? utterances : [],
      words: [],
      text,
      language_code: guessLanguage(text || screenplay),
      imported: true,
    },
    sentences: speakers.length ? null : utterances,
    source: fromTranscript.length ? "transcript" : "screenplay_dialogue",
    speakers,
  };
}
