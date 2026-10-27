// Video metadata from the uploaded sheet, recognised by column name. Known columns (genre, retention, CTR, publish
// date…) are parsed to a type and used by the pipeline; any other column is kept as-is under its own name ("extra").
// Stored per video in media_metadata.sheet = { fields: { key: value }, extra: { "Column Name": "text" } }.
import { fixMojibake, parseDuration } from "../importing/textImport.js";

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

/**
 * key → { label, type, re (header synonyms, matched against the normalised header), use }
 * types: text | longtext | list | language | count | number | percent | duration | date
 */
export const METADATA_FIELDS = {
  genre: { label: "Genre", type: "text", re: /^(genre|primary_genre|main_genre|content_genre)$/, use: "Overrides the genre Gemini detects" },
  subgenre: { label: "Subgenre", type: "text", re: /^(sub_?genre|secondary_genre|niche|genre_2)$/, use: "Overrides the subgenre Gemini detects" },
  language: { label: "Language", type: "language", re: /^(language|lang|video_language|audio_language)$/, use: "Overrides the detected language" },
  platform: { label: "Platform", type: "text", re: /^(platform|channel|network|source|page|page_name|channel_name)$/, use: "Compared best vs bad" },
  published_at: { label: "Published", type: "date", re: /^(publish(ed)?(_on|_at|_date)?|upload(ed)?(_on|_at|_date)?|post(ed)?(_on|_at|_date)?|release(d)?(_on|_date)?|date|air_date)$/ },
  reach: { label: "Reach", type: "count", re: /^(reach|unique_viewers|accounts_reached)$/, use: "Compared best vs bad" },
  impressions: { label: "Impressions", type: "count", re: /^(impressions|impr)$/, use: "Compared best vs bad" },
  plays_3s: { label: "3-second plays", type: "count", re: /^(3s_plays|3_second_(plays|views)|3sec_views|three_second_views)$/, use: "Compared best vs bad" },
  saves: { label: "Saves", type: "count", re: /^(saves|saved|bookmarks)$/, use: "Compared best vs bad" },
  followers_gained: { label: "Followers gained", type: "count", re: /^(followers?_gained|new_followers|subscribers?_gained|subs_gained|follows)$/, use: "Compared best vs bad" },
  watch_time: { label: "Watch time (min)", type: "number", re: /^(watch_?time|watch_time_(mins?|minutes)|total_watch_time|minutes_viewed|watch_minutes)$/, use: "Compared best vs bad" },
  avg_view_duration: { label: "Avg. view duration", type: "duration", re: /^(avg|average)_(view|watch)_(duration|time)(_secs?|_seconds)?$|^avd$/, use: "Compared best vs bad" },
  retention: { label: "Retention %", type: "percent", re: /^((avg|average)_)?(retention|audience_retention|completion(_rate)?|view_through(_rate)?|vtr|percent_viewed|avg_percent_viewed)(_pct|_percent|_%)?$/, use: "Compared best vs bad" },
  ctr: { label: "CTR %", type: "percent", re: /^(ctr|click_through(_rate)?|thumbnail_ctr|impressions_ctr)(_pct|_percent|_%)?$/, use: "Compared best vs bad" },
  engagement_rate: { label: "Engagement rate %", type: "percent", re: /^(engagement(_rate)?|er)(_pct|_percent|_%)?$/, use: "Compared best vs bad" },
  spend: { label: "Spend", type: "number", re: /^(spend|ad_spend|budget|cost|amount_spent)$/, use: "Compared best vs bad" },
  revenue: { label: "Revenue", type: "number", re: /^(revenue|earnings|income|rpm_revenue)$/, use: "Compared best vs bad" },
  description: { label: "Description", type: "longtext", re: /^(description|caption|synopsis|summary|logline|plot)$/, use: "Context for the analysis" },
  tags: { label: "Tags", type: "list", re: /^(tags|hashtags|keywords|topics)$/, use: "Context for the analysis" },
  hook: { label: "Hook (written)", type: "longtext", re: /^(hook|opening_hook|hook_line|hook_text)$/, use: "Context for the analysis" },
  series: { label: "Series", type: "text", re: /^(series|show|series_name|show_name|franchise)$/, use: "Compared best vs bad" },
  episode: { label: "Episode", type: "text", re: /^(episode|ep|episode_no|episode_number|part)$/ },
  cast: { label: "Cast", type: "list", re: /^(cast|actors|starring|talent)$/ },
  creator: { label: "Creator", type: "text", re: /^(creator|director|writer|editor|producer|made_by)$/, use: "Compared best vs bad" },
  audience: { label: "Target audience", type: "text", re: /^(audience|target_audience|demographic|target)$/, use: "Context for the analysis" },
  notes: { label: "Notes", type: "longtext", re: /^(notes?|remarks|comments_internal|internal_notes)$/ },
};

/** Fields that are compared between best and bad videos in the dataset. */
export const NUMERIC_TYPES = new Set(["count", "number", "percent", "duration"]);
export const CATEGORY_FIELDS = ["platform", "series", "creator", "audience"];
/** Fields sent to Gemini as context (as data, never as instructions). */
export const CONTEXT_FIELDS = ["genre", "subgenre", "language", "description", "tags", "hook", "series", "episode", "audience"];

const MAX_EXTRA_COLUMNS = 40;
const MAX_TEXT = 500, MAX_LONGTEXT = 4000;

const LANGS = {
  hindi: "hi", english: "en", tamil: "ta", telugu: "te", bengali: "bn", bangla: "bn", marathi: "mr", gujarati: "gu", punjabi: "pa",
  urdu: "ur", kannada: "kn", malayalam: "ml", odia: "or", oriya: "or", assamese: "as", bhojpuri: "bho", haryanvi: "bgc", spanish: "es",
  french: "fr", german: "de", portuguese: "pt", arabic: "ar", indonesian: "id", hinglish: "hi",
};

const clean = v => (v === undefined || v === null ? "" : String(v).trim());

/** "Hindi" | "hi" | "HI-IN" → "hi"; unknown names are kept lower-cased. */
export function parseLanguage(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return { value: null };
  if (LANGS[s]) return { value: LANGS[s] };
  const code = s.match(/^([a-z]{2,3})(?:[-_][a-z]{2})?$/);
  return { value: code ? code[1] : s.slice(0, 32) };
}

/** "45%" | 45 | 0.45 (Excel percent cell / fraction) → 45. */
export function parsePercent(raw) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  const s = String(raw).trim().replace(/,/g, "");
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*%?$/);
  if (!m) return { value: null, error: `"${raw}" is not a percentage` };
  let n = parseFloat(m[1]);
  if (!s.endsWith("%") && Math.abs(n) <= 1) n *= 100; // fractions: 0.45 → 45%
  return { value: Math.round(n * 100) / 100 };
}

/** Plain number ("1,234.5", "$300", "₹1.2K"). */
export function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : { value: null, error: "must be a number" };
  const s = String(raw).trim().replace(/[,\s_$€£₹]/g, "");
  const m = s.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return { value: null, error: `"${raw}" is not a number` };
  return { value: Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1) * 100) / 100 };
}

/** Excel serial date | "2026-03-14" | "14/03/2026" | "Mar 14, 2026" → "2026-03-14". */
export function parseDate(raw) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (typeof raw === "number") {
    if (raw > 20000 && raw < 80000) return { value: new Date(Math.round((raw - 25569) * 86400000)).toISOString().slice(0, 10) };
    return { value: null, error: `"${raw}" is not a date` };
  }
  const s = clean(raw);
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // day-first, as used in India/UK sheets
  if (dmy) {
    const [, d, mo, y] = dmy.map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() === mo - 1) return { value: dt.toISOString().slice(0, 10) };
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? { value: new Date(t).toISOString().slice(0, 10) } : { value: null, error: `"${raw}" is not a date` };
}

function parseValue(type, raw) {
  switch (type) {
    case "count": return parseCount(raw);
    case "number": return parseNumber(raw);
    case "percent": return parsePercent(raw);
    case "duration": { const v = parseDuration(raw); return v === null && clean(raw) ? { value: null, error: `"${raw}" is not a duration` } : { value: v }; }
    case "date": return parseDate(raw);
    case "language": return parseLanguage(raw);
    case "list": { const items = fixMojibake(clean(raw)).split(/[,;|\n]+|\s(?=#)/).map(t => t.trim().replace(/^#/, "")).filter(Boolean).slice(0, 30); return { value: items.length ? items.map(t => t.slice(0, 60)) : null }; }
    case "longtext": return { value: fixMojibake(clean(raw)).slice(0, MAX_LONGTEXT) || null };
    default: return { value: fixMojibake(clean(raw)).slice(0, MAX_TEXT) || null };
  }
}

/**
 * Work out which columns are metadata. `headers` are normalised (lower_snake) names, `labels` the originals;
 * `taken` holds the column indexes already used (URL, title, performance, transcript…).
 * @returns {{ fields: {key, index, header}[], extra: {index, header}[] }}
 */
export function detectMetadataColumns(headers, labels, taken) {
  const fields = [], extra = [];
  const used = new Set();
  headers.forEach((raw, index) => {
    const h = String(raw || "").replace(/[^\p{L}\p{N}%]+/gu, "_").replace(/^_+|_+$/g, ""); // "Watch Time (mins)" → watch_time_mins
    if (taken.has(index) || !h) return;
    const key = Object.keys(METADATA_FIELDS).find(k => !used.has(k) && METADATA_FIELDS[k].re.test(h));
    if (key) { used.add(key); fields.push({ key, index, header: labels[index] }); }
    else if (extra.length < MAX_EXTRA_COLUMNS && !/^(unnamed|column)?_?\d*$/.test(h)) extra.push({ index, header: labels[index] });
  });
  return { fields, extra };
}

/** One row's metadata; warnings for values that could not be read. */
export function readMetadata(cells, cols) {
  const fields = {}, extra = {}, warnings = [];
  for (const { key, index, header } of cols.fields) {
    const { value, error } = parseValue(METADATA_FIELDS[key].type, cells[index]);
    if (value !== null && value !== undefined) fields[key] = value;
    if (error) warnings.push(`${header}: ${error} — ignored`);
  }
  for (const { index, header } of cols.extra) {
    const v = fixMojibake(clean(cells[index])).slice(0, MAX_TEXT);
    if (v) extra[header] = v;
  }
  return { metadata: Object.keys(fields).length || Object.keys(extra).length ? { fields, extra } : null, warnings };
}

/** Column summary for the preview: what each metadata column was recognised as. */
export function describeColumns(cols) {
  return {
    fields: cols.fields.map(({ key, header }) => ({ key, header, label: METADATA_FIELDS[key].label, type: METADATA_FIELDS[key].type, use: METADATA_FIELDS[key].use || "Shown with the video" })),
    extra: cols.extra.map(c => c.header),
  };
}

/** Sheet context for the analysis prompt (only fields that help describe the story). */
export function analysisContext(sheet) {
  const f = sheet?.fields || {};
  const ctx = {};
  for (const k of CONTEXT_FIELDS) if (f[k] !== undefined) ctx[METADATA_FIELDS[k].label] = f[k];
  return Object.keys(ctx).length ? ctx : null;
}

/** One video's sheet metadata as labelled entries for display: recognised fields first, then the other columns. */
export function sheetEntries(sheet) {
  if (!sheet) return [];
  return [
    ...Object.entries(sheet.fields || {}).map(([key, value]) => ({ key, label: METADATA_FIELDS[key]?.label || key, type: METADATA_FIELDS[key]?.type || "text", value })),
    ...Object.entries(sheet.extra || {}).map(([label, value]) => ({ key: null, label, type: "text", value })),
  ];
}
