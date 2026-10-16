// Browser-safe constants (no Node imports) — the client imports this file directly.

export const VIDEO_STATUS = Object.freeze({
  PENDING: "PENDING",
  DOWNLOADING: "DOWNLOADING",
  AUDIO_EXTRACTION: "AUDIO_EXTRACTION",
  ANALYSIS_PENDING: "ANALYSIS_PENDING",
  TRANSCRIBING: "TRANSCRIBING",
  SCREENPLAY_ANALYSIS: "SCREENPLAY_ANALYSIS",
  MATCHING: "MATCHING",
  GENERATION_PENDING: "GENERATION_PENDING",
  SCRIPT_GENERATION: "SCRIPT_GENERATION",
  COMPLETED: "COMPLETED",
  INCONCLUSIVE: "INCONCLUSIVE",
  SKIPPED_LOW_SCORE: "SKIPPED_LOW_SCORE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

/** Terminal states: no further automatic work happens. */
export const TERMINAL_STATUSES = Object.freeze([
  VIDEO_STATUS.COMPLETED,
  VIDEO_STATUS.INCONCLUSIVE,
  VIDEO_STATUS.SKIPPED_LOW_SCORE,
  VIDEO_STATUS.FAILED,
  VIDEO_STATUS.CANCELLED,
]);

/** Independently tracked sub-task states (transcription and screenplay analysis run concurrently). */
export const TASK_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  DONE: "DONE",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});

/** Pipeline stages — each is a queue/job type with its own retry policy and timeout. */
export const STAGES = Object.freeze({
  DOWNLOAD: "download",
  AUDIO: "audio",
  TRANSCRIBE: "transcribe",
  ANALYZE: "analyze",
  MATCH: "match",
  GENERATE: "generate",
  SCRIPT: "script",       // standalone script from the dataset (not tied to a video)
});
export const STAGE_ORDER = Object.freeze(["download", "audio", "transcribe", "analyze", "match", "generate"]);

export const BATCH_STATUS = Object.freeze({
  DRAFT: "DRAFT",           // uploaded + validated, not started
  QUEUED: "QUEUED",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",   // every video reached a terminal state
  CANCELLED: "CANCELLED",
});

export const MATCH_STATUS = Object.freeze({
  MATCHED: "MATCHED",
  PARTIAL: "PARTIAL",           // scored, below threshold
  MISMATCHED: "MISMATCHED",     // strong contradictions
  INCONCLUSIVE: "INCONCLUSIVE", // insufficient evidence
});

export const GENERATION_STATUS = Object.freeze({
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  AWAITING_MANUAL: "AWAITING_MANUAL", // manual skill workflow: exported, waiting for import
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",               // failed originality validation
  FAILED: "FAILED",
  DISABLED: "DISABLED",               // no skill configured
  DATASET: "DATASET",                 // training video — analysed for the dataset, no per-video script
});

export const BATCH_PURPOSE = Object.freeze({ GENERATION: "generation", DATASET: "dataset" });
export const PERFORMANCE = Object.freeze({ BEST: "best", BAD: "bad" });

export const SCRIPT_STATUS = Object.freeze({
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  AWAITING_MANUAL: "AWAITING_MANUAL",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
  DISABLED: "DISABLED",
});

export const DEFAULT_SCORING = Object.freeze({
  matchThreshold: 75,
  storyWeight: 40,
  characterWeight: 30,
  dialogueWeight: 30,
  minMatchConfidence: 0.7,
});

export const SCORING_VERSION = "1.0";

export const OPTIONAL_COLUMNS = Object.freeze(["title", "category", "views", "likes", "shares", "comments", "performance"]);
