// Parses .xlsx/.xls uploads into validated video rows. Rows are validated independently:
// invalid rows are reported, never cause the whole sheet to be rejected.
import * as XLSX from "xlsx";
import { OPTIONAL_COLUMNS } from "@reelscript/shared";
import { normalizeVideoUrl, UrlValidationError } from "../url/UrlValidator.js";
import { badRequest } from "../../utils/errors.js";
import { fixMojibake, parseDuration, screenplayDuration } from "../importing/textImport.js";

const URL_HEADER = /^video[\s_-]*url$/i;
const HEADER_SCAN_ROWS = 10;

/** Detect spreadsheet type from magic bytes — never trust the extension alone. */
export function detectSpreadsheetType(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "xlsx"; // ZIP container
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "xls"; // OLE2
  return null;
}

/** A CSV is plain text: no NUL bytes in the first 64 KB. */
const looksLikeText = (buf) => buf && buf.length > 0 && !buf.subarray(0, 65536).includes(0);

// Training rows may carry an existing transcript + screenplay (text), analysed instead of the video.
const IMPORT_HEADERS = {
  screenplay: /^(screenplay|screen_play|screenplay_text|screenplay_analysis|script|screenplay_script)$/,
  transcript: /^(transcript|transcription|transcript_text)$/,
  duration: /^(duration|duration_sec|duration_secs|duration_seconds|length|length_sec|video_duration|seconds)$/,
};
const MAX_IMPORT_CHARS = 200_000;

/** "250,000" | "1.2K" | "3M" | 1200 → integer, or null. Returns { value, error }. */
export function parseCount(raw) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? { value: Math.round(raw) } : { value: null, error: "must be a non-negative number" };
  const s = String(raw).trim().replace(/[,\s_]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return { value: null, error: `"${raw}" is not a number` };
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
  return { value: Math.round(parseFloat(m[1]) * mult) };
}

const clean = v => (v === undefined || v === null ? "" : String(v).trim());

const BEST = /^(best|good|top|high|hit|winner|viral|success|1|yes|y|true|✓|✔)$/i;
const BAD = /^(bad|poor|low|worst|flop|fail|failed|loser|0|no|n|false|✗|✘)$/i;
/** "Best" / "top" / 1 → "best"; "Bad" / "flop" / 0 → "bad"; empty → null; anything else → undefined (invalid). */
export function parsePerformance(raw) {
  const s = clean(raw);
  if (!s) return null;
  if (BEST.test(s)) return "best";
  if (BAD.test(s)) return "bad";
  return undefined;
}

export function parseSpreadsheet(buffer, { filename = "upload", allowedHosts, maxRows = 5000, purpose = "generation" } = {}) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (!["xlsx", "xls", "csv"].includes(ext)) throw badRequest("Only .xlsx, .xls and .csv files are supported");
  const type = ext === "csv" ? (looksLikeText(buffer) ? "csv" : null) : detectSpreadsheetType(buffer);
  if (!type) throw badRequest(ext === "csv" ? "The file is not a valid CSV (text) file" : "The file is not a valid Excel workbook");

  let wb;
  try {
    wb = type === "csv"
      // UTF-8 (with or without BOM); keep cells as text so long transcripts and numbers aren't reinterpreted.
      ? XLSX.read(buffer.toString("utf8").replace(/^\uFEFF/, ""), { type: "string", raw: true, cellDates: false })
      : XLSX.read(buffer, { type: "buffer", cellDates: false, cellHTML: false, cellFormula: false, sheetStubs: false });
  } catch (e) {
    throw badRequest(`Could not read the ${type === "csv" ? "CSV file" : "workbook"}: ${e.message}`);
  }

  // Find the first sheet + header row that contains a video_url column (case-insensitive).
  let found = null;
  for (const sheetName of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "", raw: true, blankrows: true });
    for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, grid.length); r++) {
      const idx = grid[r].findIndex(c => URL_HEADER.test(clean(c)));
      if (idx >= 0) { found = { sheetName, grid, headerRow: r, urlCol: idx }; break; }
    }
    if (found) break;
  }
  if (!found) throw badRequest('No "video_url" column found. Add a header named video_url (case-insensitive) in the first 10 rows.');

  const { sheetName, grid, headerRow, urlCol } = found;
  const headers = grid[headerRow].map(h => clean(h).replace(/^\uFEFF/, "").toLowerCase().replace(/[\s-]+/g, "_"));
  const colIndex = Object.fromEntries(OPTIONAL_COLUMNS.map(c => [c, headers.indexOf(c)]));
  // Accept common synonyms for the performance label column.
  if (colIndex.performance < 0) colIndex.performance = headers.findIndex(h => /^(performance|label|result|class|bucket|best_bad|perf)$/.test(h));
  const datasetMode = purpose === "dataset";
  if (datasetMode && colIndex.performance < 0) throw badRequest('Training datasets need a "performance" column with best or bad for every row.');
  // Existing transcript/screenplay text is only used for training datasets (generation needs the real video for matching).
  const importCol = Object.fromEntries(Object.entries(IMPORT_HEADERS).map(([k, re]) => [k, datasetMode ? headers.findIndex(h => re.test(h)) : -1]));
  const importMode = importCol.screenplay >= 0;

  const rows = [];
  const seen = new Map(); // normalized_url → first row number
  const dataRows = grid.slice(headerRow + 1);
  let nonEmpty = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i];
    const rowNumber = headerRow + 2 + i; // 1-based spreadsheet row number
    if (!cells || cells.every(c => clean(c) === "")) continue;
    nonEmpty++;
    if (nonEmpty > maxRows) throw badRequest(`Too many rows: the limit is ${maxRows} per batch`);

    const rawUrl = clean(cells[urlCol]);
    const row = { row: rowNumber, video_url: rawUrl, normalized_url: null, external_id: null, valid: false, errors: [], warnings: [], duplicate_of: null };

    row.title = colIndex.title >= 0 ? clean(cells[colIndex.title]).slice(0, 500) || null : null;
    row.category = colIndex.category >= 0 ? clean(cells[colIndex.category]).slice(0, 128) || null : null;
    for (const k of ["views", "likes", "shares", "comments"]) {
      if (colIndex[k] < 0) { row[k] = null; continue; }
      const { value, error } = parseCount(cells[colIndex[k]]);
      row[k] = value;
      if (error) row.warnings.push(`${k}: ${error} — ignored`);
    }

    row.performance = null;
    if (colIndex.performance >= 0) {
      const label = parsePerformance(cells[colIndex.performance]);
      if (label === undefined) row[datasetMode ? "errors" : "warnings"].push(datasetMode
        ? { code: "BAD_LABEL", message: `performance "${clean(cells[colIndex.performance])}" is not best or bad` }
        : `performance "${clean(cells[colIndex.performance])}" is not best or bad — ignored`);
      else row.performance = label;
      if (datasetMode && label === null) row.errors.push({ code: "MISSING_LABEL", message: "performance is empty (best or bad required)" });
    }

    if (!rawUrl) {
      row.errors.push({ code: "EMPTY", message: "video_url is empty" });
    } else {
      try {
        const n = normalizeVideoUrl(rawUrl, { allowedHosts });
        row.normalized_url = n.normalizedUrl;
        row.external_id = n.externalId;
        if (seen.has(n.normalizedUrl)) {
          row.duplicate_of = seen.get(n.normalizedUrl);
          row.errors.push({ code: "DUPLICATE", message: `Duplicate of row ${row.duplicate_of}` });
        } else {
          seen.set(n.normalizedUrl, rowNumber);
        }
      } catch (e) {
        if (!(e instanceof UrlValidationError)) throw e;
        row.errors.push({ code: e.code, message: e.message });
      }
    }
    if (importMode) {
      const screenplay = fixMojibake(clean(cells[importCol.screenplay])).slice(0, MAX_IMPORT_CHARS);
      const transcript = importCol.transcript >= 0 ? fixMojibake(clean(cells[importCol.transcript])).slice(0, MAX_IMPORT_CHARS) : "";
      if (screenplay) {
        const duration = (importCol.duration >= 0 ? parseDuration(cells[importCol.duration]) : null) ?? screenplayDuration(screenplay);
        row.import = { screenplay, transcript, duration };
        if (!transcript) row.warnings.push("no transcript — dialogue is taken from the screenplay");
        if (!duration) row.warnings.push("no duration — estimated during analysis");
      } else {
        row.warnings.push("no screenplay text — this video will be downloaded and analysed instead");
      }
    }
    if (row.title) row.title = fixMojibake(row.title);
    row.valid = row.errors.length === 0;
    rows.push(row);
  }

  const summary = {
    total_rows: rows.length,
    valid: rows.filter(r => r.valid).length,
    invalid: rows.filter(r => !r.valid).length,
    duplicates: rows.filter(r => r.duplicate_of).length,
    ...(colIndex.performance >= 0 ? { best: rows.filter(r => r.valid && r.performance === "best").length, bad: rows.filter(r => r.valid && r.performance === "bad").length } : {}),
    ...(importMode ? { imported: rows.filter(r => r.valid && r.import).length } : {}),
  };
  return {
    filename,
    purpose,
    file_type: type,
    sheet: sheetName,
    header_row: headerRow + 1,
    columns: {
      video_url: grid[headerRow][urlCol],
      optional_found: OPTIONAL_COLUMNS.filter(c => colIndex[c] >= 0),
      optional_missing: OPTIONAL_COLUMNS.filter(c => colIndex[c] < 0),
      import_found: Object.keys(importCol).filter(k => importCol[k] >= 0),
    },
    rows,
    summary,
  };
}

/** CSV report of invalid rows (downloadable). */
export function validationReportCsv(parsed) {
  const esc = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [["row", "video_url", "error_codes", "errors", "warnings"].join(",")];
  for (const r of parsed.rows.filter(r => !r.valid || r.warnings.length))
    lines.push([r.row, r.video_url, r.errors.map(e => e.code).join("|"), r.errors.map(e => e.message).join("; "), r.warnings.join("; ")].map(esc).join(","));
  return lines.join("\n") + "\n";
}
