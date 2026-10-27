// Display formatting + status → semantic colour mapping (one meaning per colour).

export const fmtScore = (n) => (n === null || n === undefined ? "—" : Math.round(n));
export const fmtConf = (n) => (n === null || n === undefined ? "—" : n.toFixed(2));
export const fmtInt = (n) => (n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString());
export const fmtTime = (s) => {
  if (s === null || s === undefined || Number.isNaN(s)) return "—";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};
export const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export const fmtMs = (ms) => (ms === null || ms === undefined ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
export const titleCase = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

const PROCESSING = ["DOWNLOADING", "AUDIO_EXTRACTION", "ANALYSIS_PENDING", "TRANSCRIBING", "SCREENPLAY_ANALYSIS", "MATCHING", "GENERATION_PENDING", "SCRIPT_GENERATION"];
export const isProcessing = (s) => PROCESSING.includes(s);

/** Video pipeline status → { kind, label } */
export function videoStatus(s) {
  if (isProcessing(s)) return { kind: "info", label: { DOWNLOADING: "Downloading", AUDIO_EXTRACTION: "Extracting audio", ANALYSIS_PENDING: "Analysis queued", TRANSCRIBING: "Transcribing", SCREENPLAY_ANALYSIS: "Analysing video", MATCHING: "Matching", GENERATION_PENDING: "Generation queued", SCRIPT_GENERATION: "Writing script" }[s], spinning: true };
  return {
    PENDING: { kind: "neutral", label: "Queued" },
    COMPLETED: { kind: "success", label: "Completed" },
    INCONCLUSIVE: { kind: "warning", label: "Needs review" },
    SKIPPED_LOW_SCORE: { kind: "neutral", label: "Below threshold" },
    FAILED: { kind: "error", label: "Failed" },
    CANCELLED: { kind: "neutral", label: "Cancelled" },
  }[s] || { kind: "neutral", label: titleCase(s) };
}

export function matchStatus(s) {
  return {
    MATCHED: { kind: "success", label: "Matched" },
    PARTIAL: { kind: "warning", label: "Partial" },
    MISMATCHED: { kind: "error", label: "Mismatched" },
    INCONCLUSIVE: { kind: "warning", label: "Inconclusive" },
  }[s] || { kind: "neutral", label: s ? titleCase(s) : "Not scored" };
}

export function generationStatus(s) {
  return {
    COMPLETED: { kind: "success", label: "Script ready" },
    PENDING: { kind: "info", label: "Queued", spinning: true },
    RUNNING: { kind: "info", label: "Generating", spinning: true },
    AWAITING_MANUAL: { kind: "warning", label: "Awaiting import" },
    REJECTED: { kind: "error", label: "Rejected (originality)" },
    FAILED: { kind: "error", label: "Failed" },
    DISABLED: { kind: "neutral", label: "Skill not configured" },
    NOT_ELIGIBLE: { kind: "neutral", label: "Not eligible" },
    DATASET: { kind: "neutral", label: "Training data" },
  }[s] || { kind: "neutral", label: titleCase(s) };
}

export function taskStatus(s) {
  return {
    PENDING: { kind: "neutral", label: "Pending" },
    RUNNING: { kind: "info", label: "Running", spinning: true },
    DONE: { kind: "success", label: "Done" },
    FAILED: { kind: "error", label: "Failed" },
    SKIPPED: { kind: "neutral", label: "Skipped" },
  }[s] || { kind: "neutral", label: titleCase(s) };
}

/** Score → semantic tone relative to the threshold (colour + label always shown together). */
export function scoreTone(score, threshold) {
  if (score === null || score === undefined) return "neutral";
  if (score >= threshold) return "success";
  if (score >= threshold - 15) return "warning";
  return "error";
}

export const REASON_TEXT = {
  screenplay_missing: "Screenplay analysis missing",
  screenplay_malformed: "Screenplay analysis malformed",
  transcript_missing: "Transcript missing",
  transcript_empty_or_incomplete: "Transcript empty though dialogue was described",
  little_or_no_speech: "Little or no speech",
  low_transcription_confidence: "Low transcription confidence",
  transcript_incomplete: "Transcript incomplete",
  language_incompatible: "Languages differ and embeddings aren't multilingual",
  story_not_evaluable: "Story not comparable",
  dialogue_not_evaluable: "No dialogue to compare",
  characters_not_evaluable: "Characters not comparable",
  insufficient_evidence_quality: "Evidence quality too low",
};

/** A sheet metadata value for display, by its type (see server sheetMetadata.js). */
export function fmtMeta(type, v) {
  if (v === null || v === undefined || v === "") return "—";
  switch (type) {
    case "percent": return `${v}%`;
    case "duration": return secs(v);
    case "count": return Number(v).toLocaleString();
    case "number": return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
    case "language": return String(v).toUpperCase();
    case "list": return [].concat(v).join(", ");
    default: return String(v);
  }
}

export const isScriptBusy = (status) => status === "QUEUED" || status === "RUNNING";

/** "m:ss" (or "h:mm:ss") since an ISO time. */
export function elapsed(since, now = Date.now()) {
  const t = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function scriptStatus(s) {
  return {
    QUEUED: { kind: "info", label: "Queued", spinning: true },
    RUNNING: { kind: "info", label: "Writing", spinning: true },
    AWAITING_MANUAL: { kind: "warning", label: "Awaiting import" },
    COMPLETED: { kind: "ai", label: "AI script ready" },
    REJECTED: { kind: "error", label: "Rejected (originality)" },
    FAILED: { kind: "error", label: "Failed" },
    DISABLED: { kind: "neutral", label: "Skill not configured" },
  }[s] || { kind: "neutral", label: titleCase(s) };
}

export const pct = (n) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`);
export const secs = (n) => (n === null || n === undefined ? "—" : n >= 90 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${Math.round(n)}s`);
