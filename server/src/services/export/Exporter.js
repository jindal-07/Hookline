// CSV / Excel / JSON exports. Spreadsheet cells are protected against formula injection.
import * as XLSX from "xlsx";

export const SUMMARY_COLUMNS = [
  "video_url", "title", "category", "views", "likes", "shares", "status",
  "story_score", "character_score", "dialogue_score", "overall_score", "confidence",
  "match_status", "generation_status", "generated_script", "error_message",
];

const round = (n, d = 1) => (n === null || n === undefined ? "" : Math.round(n * 10 ** d) / 10 ** d);

/** Build one summary row from a video with its latest match + script. */
export function summaryRow(v, match, script) {
  return {
    video_url: v.video_url,
    title: v.title ?? "",
    category: v.category ?? "",
    views: v.views ?? "",
    likes: v.likes ?? "",
    shares: v.shares ?? "",
    status: v.status,
    story_score: round(match?.story_score),
    character_score: round(match?.character_score),
    dialogue_score: round(match?.dialogue_score),
    overall_score: round(match?.overall_score),
    confidence: round(match?.confidence, 3),
    match_status: match?.match_status ?? "",
    generation_status: v.generation_status ?? "",
    generated_script: script?.generation_status === "COMPLETED" ? script.script_content ?? "" : "",
    error_message: v.error_message ?? "",
  };
}

/** Neutralise values that spreadsheet apps would execute as formulas. */
export function safeCell(value) {
  if (typeof value !== "string") return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function toCsv(rows, columns = SUMMARY_COLUMNS) {
  const esc = (v) => {
    const s = String(safeCell(v ?? ""));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [columns.join(","), ...rows.map(r => columns.map(c => esc(r[c])).join(","))].join("\r\n") + "\r\n";
}

export function toXlsx(rows, columns = SUMMARY_COLUMNS, sheetName = "Videos") {
  const data = rows.map(r => columns.map(c => safeCell(r[c] ?? "")));
  const ws = XLSX.utils.aoa_to_sheet([columns, ...data]);
  ws["!cols"] = columns.map(c => ({ wch: c === "generated_script" ? 60 : c === "video_url" ? 45 : 14 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

/** Detailed per-video export: transcript, screenplay analysis, evidence, Story DNA, script. */
export function detailedRecord({ video, transcript, analysis, match, storyDna, script, logs }) {
  return {
    video: {
      id: video.id, batch_id: video.batch_id, video_url: video.video_url, normalized_url: video.normalized_url,
      source_row_number: video.source_row_number, title: video.title, category: video.category,
      views: video.views, likes: video.likes, shares: video.shares, comments: video.comments, performance_label: video.performance_label ?? null,
      status: video.status, generation_status: video.generation_status, error_code: video.error_code, error_message: video.error_message,
    },
    transcript: transcript ? { language: transcript.language, duration_seconds: transcript.duration_seconds, normalized: transcript.normalized_transcript, provider: transcript.provider_metadata } : null,
    screenplay_analysis: analysis ? { normalized: analysis.normalized_analysis, model: analysis.model_metadata } : null,
    match: match ? {
      overall_score: match.overall_score, story_score: match.story_score, character_score: match.character_score, dialogue_score: match.dialogue_score,
      confidence: match.confidence, match_status: match.match_status, eligible: match.eligible, reasoning: match.reasoning,
      evidence: match.evidence, scoring_version: match.scoring_version, scoring_configuration: match.scoring_configuration,
    } : null,
    story_dna: storyDna?.story_dna ?? null,
    generated_script: script ? { status: script.generation_status, content: script.script_content, skill: script.skill_identifier, skill_version: script.skill_version, metadata: script.generation_metadata } : null,
    processing_history: (logs || []).map(l => ({ stage: l.stage, status: l.status, attempt: l.attempt, duration_ms: l.duration_ms, error: l.error_details, at: l.created_at })),
  };
}
