// Builds the training dataset profile from best/bad-labelled, analysed videos. Deterministic — no LLM.
// Answers: which genres/subgenres and durations worked, and which story patterns separate best from bad.
// Metadata from the uploaded sheet takes priority (genre, subgenre, language) and adds the team's own metrics
// (retention, CTR, watch time…) and categories (platform, series…) to the comparison.
import { METADATA_FIELDS, NUMERIC_TYPES, CATEGORY_FIELDS } from "../excel/sheetMetadata.js";

export const BUILDER_VERSION = "1.0";
const MIN_GROUP = 3;          // groups smaller than this are shown but flagged and never recommended
const LIFT_STRONG = 1.5;      // pattern is "winning" at ≥1.5× more common in best than bad (inverse for "avoid")
const SMOOTH = 0.05;          // additive smoothing for shares when computing lift

export const DURATION_BUCKETS = [[0, 30], [30, 60], [60, 90], [90, 120], [120, 180], [180, 300], [300, Infinity]];

const r1 = n => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const r3 = n => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 1000) / 1000);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** "  family DRAMA " → "Family Drama"; empty → fallback */
export function canonical(s, fallback = "Unspecified") {
  const raw = String(s ?? "").trim();
  if (!raw || /^(n\s*\/?\s*a|none|unknown|other|-+|null|undefined)$/i.test(raw)) return fallback;
  const t = raw.replace(/&/g, " and ").replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
  return t.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase());
}

/** Genre and subgenre: the sheet's when it has them, otherwise what the analysis detected. */
export function labelsOf(video, analysis) {
  const sheet = video.media_metadata?.sheet?.fields || {};
  const genre = canonical(sheet.genre || analysis.metadata.genre);
  const subgenre = canonical(sheet.subgenre || analysis.metadata.subgenre);
  return { genre, subgenre, genre_source: sheet.genre ? "sheet" : "analysis", subgenre_source: sheet.subgenre ? "sheet" : "analysis" };
}

/** Reduce one analysed video to the features the dataset compares. */
export function extractFeatures({ video, analysis, transcript, storyDna, match }) {
  const A = analysis;
  const sheet = video.media_metadata?.sheet?.fields || {};
  const labels = labelsOf(video, A);
  const metrics = {}, categories = {};
  for (const [k, v] of Object.entries(sheet)) {
    if (NUMERIC_TYPES.has(METADATA_FIELDS[k]?.type) && Number.isFinite(v)) metrics[k] = v;
    if (CATEGORY_FIELDS.includes(k) && v) categories[k] = canonical(v);
  }
  const dna = storyDna || {};
  const duration = Number(video.media_metadata?.download?.duration_seconds) || Number(video.media_metadata?.import?.duration) || Number(A.metadata.duration_seconds) || null;
  const stages = (A.emotional_arc?.stages || []).map(s => canonical(s, null)).filter(Boolean);
  return {
    video_id: video.id,
    label: video.performance_label,
    ...labels,
    duration,
    scene_count: A.scenes.length,
    language: sheet.language || (transcript?.language && transcript.language !== "unknown" ? transcript.language : A.metadata.primary_language) || "unknown",
    metrics,
    categories,
    views: video.views ?? null, likes: video.likes ?? null, shares: video.shares ?? null,
    speech_ratio: transcript?.stats?.speech_ratio ?? null,
    match_confidence: match?.confidence ?? null,
    single: {
      hook_pattern: dna.hook_pattern || null,
      pacing: dna.pacing || null,
      ending_type: dna.ending_type || null,
      arc_opening: stages[0] || null,
      arc_closing: stages.at(-1) || null,
      narrative_format: A.metadata.narrative_format ? canonical(A.metadata.narrative_format) : null,
    },
    multi: {
      story_engine: dna.story_engine || [],
      dialogue_function: dna.dialogue_functions || [],
      emotion: stages,
      structure_element: A.story_structure.filter(e => e.status === "present").map(e => e.element),
    },
  };
}

function groupStats(rows, totalBestShare) {
  const best = rows.filter(r => r.label === "best"), bad = rows.filter(r => r.label === "bad");
  const bd = best.map(r => r.duration).filter(Number.isFinite), wd = bad.map(r => r.duration).filter(Number.isFinite);
  const winRate = rows.length ? best.length / rows.length : null;
  return {
    total: rows.length,
    best: best.length,
    bad: bad.length,
    win_rate: r3(winRate),
    // Laplace-smoothed win rate keeps tiny groups from topping the ranking
    smoothed_win_rate: r3((best.length + 1) / (rows.length + 2)),
    lift_vs_overall: totalBestShare ? r3(winRate / totalBestShare) : null,
    low_sample: rows.length < MIN_GROUP,
    duration_best: { mean: r1(mean(bd)), median: r1(quantile(bd, 0.5)), p25: r1(quantile(bd, 0.25)), p75: r1(quantile(bd, 0.75)), n: bd.length },
    duration_bad: { mean: r1(mean(wd)), median: r1(quantile(wd, 0.5)), n: wd.length },
    scene_count_best: r1(mean(best.map(r => r.scene_count))),
    avg_views_best: r1(mean(best.map(r => r.views).filter(Number.isFinite))),
    avg_views_bad: r1(mean(bad.map(r => r.views).filter(Number.isFinite))),
  };
}

/** Patterns over-represented in best (winning) or bad (avoid), by lift of class shares. */
export function patternLift(rows) {
  const best = rows.filter(r => r.label === "best"), bad = rows.filter(r => r.label === "bad");
  if (!best.length || !bad.length) return { winning: [], avoid: [], all: [] };
  const counts = new Map(); // key "feature\u0000value" -> {best, bad}
  const add = (r, feature, value) => {
    if (!value) return;
    const k = `${feature}\u0000${value}`;
    const c = counts.get(k) || { feature, value, best: 0, bad: 0 };
    c[r.label]++;
    counts.set(k, c);
  };
  for (const r of rows) {
    for (const [f, v] of Object.entries(r.single)) add(r, f, v);
    for (const [f, vs] of Object.entries(r.multi)) for (const v of new Set(vs)) add(r, f, v);
  }
  const minBest = Math.max(2, Math.ceil(best.length * 0.1)), minBad = Math.max(2, Math.ceil(bad.length * 0.1));
  const all = [...counts.values()].map(c => {
    const sb = c.best / best.length, sw = c.bad / bad.length;
    return { ...c, share_best: r3(sb), share_bad: r3(sw), lift: r3((sb + SMOOTH) / (sw + SMOOTH)) };
  });
  const winning = all.filter(p => p.lift >= LIFT_STRONG && p.best >= minBest).sort((a, b) => b.lift - a.lift || b.best - a.best);
  const avoid = all.filter(p => p.lift <= 1 / LIFT_STRONG && p.bad >= minBad).sort((a, b) => a.lift - b.lift || b.bad - a.bad);
  return { winning, avoid, all };
}

/**
 * @param {Array<{video, analysis, transcript, storyDna, match}>} items  labelled, analysed dataset videos
 * @param {Array<{video_id, reason}>} excluded
 */
/**
 * @param {object} [merged]  duplicate handling from loading: { duplicate_rows, videos_in_several_sheets, label_conflicts }
 */
export function buildDatasetProfile(items, excluded = [], merged = null) {
  const rows = items.map(extractFeatures).filter(r => r.label === "best" || r.label === "bad");
  const best = rows.filter(r => r.label === "best"), bad = rows.filter(r => r.label === "bad");
  const bestShare = rows.length ? best.length / rows.length : 0;

  // Genres with nested subgenres, plus a flat genre+subgenre ranking
  const byGenre = new Map();
  for (const r of rows) (byGenre.get(r.genre) || byGenre.set(r.genre, []).get(r.genre)).push(r);
  const genres = [...byGenre.entries()].map(([genre, gr]) => {
    const subs = new Map();
    for (const r of gr) (subs.get(r.subgenre) || subs.set(r.subgenre, []).get(r.subgenre)).push(r);
    return {
      genre,
      ...groupStats(gr, bestShare),
      subgenres: [...subs.entries()].map(([subgenre, sr]) => ({ subgenre, ...groupStats(sr, bestShare) }))
        .sort((a, b) => b.smoothed_win_rate - a.smoothed_win_rate || b.total - a.total),
    };
  }).sort((a, b) => b.smoothed_win_rate - a.smoothed_win_rate || b.total - a.total);

  const combos = genres.flatMap(g => g.subgenres.map(s => ({ genre: g.genre, ...s })))
    .sort((a, b) => b.smoothed_win_rate - a.smoothed_win_rate || b.best - a.best);

  // Duration
  const buckets = DURATION_BUCKETS.map(([lo, hi]) => {
    const inB = rows.filter(r => Number.isFinite(r.duration) && r.duration >= lo && r.duration < hi);
    const b = inB.filter(r => r.label === "best").length;
    return { range: hi === Infinity ? `${lo}s+` : `${lo}–${hi}s`, lo, hi: hi === Infinity ? null : hi, total: inB.length, best: b, bad: inB.length - b, win_rate: inB.length ? r3(b / inB.length) : null, low_sample: inB.length < MIN_GROUP };
  });
  const bestDur = best.map(r => r.duration).filter(Number.isFinite);
  const sweetSpot = buckets.filter(b => !b.low_sample && b.win_rate !== null).sort((a, b) => b.win_rate - a.win_rate || b.total - a.total)[0] || null;

  // Patterns overall + per genre (only where both classes have enough examples)
  const overall = patternLift(rows);
  const byGenrePatterns = {};
  for (const [genre, gr] of byGenre) {
    const nb = gr.filter(r => r.label === "best").length, nw = gr.length - nb;
    if (nb >= 3 && nw >= 2) {
      const p = patternLift(gr);
      byGenrePatterns[genre] = { winning: p.winning.slice(0, 15), avoid: p.avoid.slice(0, 15) };
    }
  }

  // Exemplars: structural summaries of best videos per genre/subgenre (no source names or lines)
  const exemplars = {};
  const exemplarOf = (item) => {
    const { avoid, _provenance, ...dna } = item.storyDna || {};
    void avoid; void _provenance;
    return { video_id: item.video.id, duration: r1(Number(item.video.media_metadata?.download?.duration_seconds) || item.analysis.metadata.duration_seconds), scene_count: item.analysis.scenes.length, views: item.video.views ?? null, story_dna: dna };
  };
  const bestItems = items.filter(i => i.video.performance_label === "best" && i.storyDna)
    .sort((a, b) => (b.video.views ?? -1) - (a.video.views ?? -1) || (b.match?.confidence ?? 0) - (a.match?.confidence ?? 0));
  for (const it of bestItems) {
    const { genre: g, subgenre: s } = labelsOf(it.video, it.analysis);
    for (const key of [`${g}|${s}`, `${g}|*`, "*|*"]) {
      exemplars[key] ??= [];
      if (exemplars[key].length < 5) exemplars[key].push(exemplarOf(it));
    }
  }

  const notes = [];
  if (rows.length < 30) notes.push(`Only ${rows.length} usable videos — patterns are indicative, not reliable.`);
  if (best.length && bad.length && Math.max(best.length, bad.length) / Math.min(best.length, bad.length) > 2) notes.push(`Classes are imbalanced (${best.length} best vs ${bad.length} bad); win rates are relative to the ${Math.round(bestShare * 100)}% baseline.`);
  if (!best.length || !bad.length) notes.push("Both best and bad videos are needed to learn what separates them.");
  const lowGenres = genres.filter(g => g.low_sample).map(g => g.genre);
  if (lowGenres.length) notes.push(`Too few videos to judge: ${lowGenres.join(", ")}.`);
  if (merged?.duplicate_rows) notes.push(`${merged.videos_in_several_sheets} video(s) appear in more than one sheet; each counts once (${merged.duplicate_rows} repeated row(s) merged).`);
  if (merged?.label_conflicts?.length) notes.push(`${merged.label_conflicts.length} video(s) are labelled best in one sheet and bad in another; they count as best.`);
  if (excluded.length) notes.push(`${excluded.length} video(s) were excluded (failed, unlabelled or not yet analysed).`);
  const noSpeech = rows.filter(r => r.speech_ratio !== null && r.speech_ratio < 0.05).length;
  if (noSpeech) notes.push(`${noSpeech} video(s) have little or no speech; their dialogue patterns are missing.`);
  notes.push("Correlation, not causation: these patterns describe what your best videos have in common.");

  const languages = {};
  for (const r of rows) languages[r.language] = (languages[r.language] || 0) + 1;

  const sheet = sheetComparison(rows);
  const fromSheet = rows.filter(r => r.genre_source === "sheet").length;
  if (fromSheet) notes.splice(notes.length - 1, 0, `Genre taken from your sheet for ${fromSheet} of ${rows.length} videos (detected by the analysis for the rest).`);

  return {
    builder_version: BUILDER_VERSION,
    built_at: new Date().toISOString(),
    overview: {
      videos: rows.length, best: best.length, bad: bad.length, excluded: excluded.length, best_share: r3(bestShare), languages,
      duration_best: { mean: r1(mean(bestDur)), median: r1(quantile(bestDur, 0.5)), p25: r1(quantile(bestDur, 0.25)), p75: r1(quantile(bestDur, 0.75)) },
      duration_bad: { mean: r1(mean(bad.map(r => r.duration).filter(Number.isFinite))), median: r1(quantile(bad.map(r => r.duration).filter(Number.isFinite), 0.5)) },
      scene_count_best: r1(mean(best.map(r => r.scene_count))),
      scene_count_bad: r1(mean(bad.map(r => r.scene_count))),
    },
    genres,
    combos,
    duration: { buckets, sweet_spot: sweetSpot ? { range: sweetSpot.range, win_rate: sweetSpot.win_rate, total: sweetSpot.total } : null, recommended_seconds: r1(quantile(bestDur, 0.5)) },
    patterns: { winning: overall.winning.slice(0, 25), avoid: overall.avoid.slice(0, 25), by_genre: byGenrePatterns },
    exemplars,
    sheet_metadata: sheet,
    merged: merged || null,
    notes,
  };
}

/**
 * The sheet's own numbers and categories, best vs bad: medians per metric (shown when both classes have at least
 * MIN_GROUP values) and win rates per category value (platform, series, creator, audience).
 */
export function sheetComparison(rows) {
  const metrics = [];
  for (const key of new Set(rows.flatMap(r => Object.keys(r.metrics || {})))) {
    const vals = (label) => rows.filter(r => r.label === label && Number.isFinite(r.metrics?.[key])).map(r => r.metrics[key]);
    const b = vals("best"), w = vals("bad");
    const bm = quantile(b, 0.5), wm = quantile(w, 0.5);
    metrics.push({
      key, label: METADATA_FIELDS[key]?.label || key, type: METADATA_FIELDS[key]?.type || "number",
      best: { median: r1(bm), mean: r1(mean(b)), n: b.length }, bad: { median: r1(wm), mean: r1(mean(w)), n: w.length },
      ratio: bm !== null && wm ? r3(bm / wm) : null,
      low_sample: b.length < MIN_GROUP || w.length < MIN_GROUP,
    });
  }
  metrics.sort((a, b) => Number(a.low_sample) - Number(b.low_sample) || Math.abs(Math.log(b.ratio || 1)) - Math.abs(Math.log(a.ratio || 1)));

  const categories = [];
  for (const key of CATEGORY_FIELDS) {
    const withVal = rows.filter(r => r.categories?.[key]);
    if (!withVal.length) continue;
    const by = new Map();
    for (const r of withVal) (by.get(r.categories[key]) || by.set(r.categories[key], []).get(r.categories[key])).push(r);
    const values = [...by.entries()].map(([value, rs]) => {
      const nb = rs.filter(r => r.label === "best").length;
      return { value, total: rs.length, best: nb, bad: rs.length - nb, win_rate: r3(nb / rs.length), low_sample: rs.length < MIN_GROUP };
    }).sort((a, b) => Number(a.low_sample) - Number(b.low_sample) || b.win_rate - a.win_rate || b.total - a.total).slice(0, 15);
    categories.push({ key, label: METADATA_FIELDS[key].label, coverage: withVal.length, values });
  }
  return { metrics, categories, genre_from_sheet: rows.filter(r => r.genre_source === "sheet").length };
}

const FEATURE_LABEL = {
  hook_pattern: "Hook", pacing: "Pacing", ending_type: "Ending", arc_opening: "Opening emotion", arc_closing: "Closing emotion",
  narrative_format: "Format", story_engine: "Story step", dialogue_function: "Dialogue does", emotion: "Emotion", structure_element: "Structure",
};
export const featureLabel = f => FEATURE_LABEL[f] || f;

/**
 * Everything the skill needs for one brief: target group stats, duration, patterns to use/avoid and structural exemplars.
 * Exemplars carry mechanics only (hook type, story steps, arc, pacing, ending) — never a source premise, names or lines.
 */
export function playbookFor(profile, { genre, subgenre } = {}) {
  const g = profile.genres.find(x => x.genre === genre) || null;
  const s = g && subgenre ? g.subgenres.find(x => x.subgenre === subgenre) || null : null;
  const group = s || g;
  const patterns = profile.patterns.by_genre[genre] || { winning: profile.patterns.winning, avoid: profile.patterns.avoid };
  const durationFrom = (grp) => (grp && grp.duration_best.n >= 2 ? grp.duration_best : null);
  const dur = durationFrom(s) || durationFrom(g) || profile.overview.duration_best;
  const exemplars = (profile.exemplars[`${genre}|${subgenre}`] || profile.exemplars[`${genre}|*`] || profile.exemplars["*|*"] || []).slice(0, 3);
  const fmt = p => `${featureLabel(p.feature)}: ${p.value} (${p.best}/${profile.overview.best} best vs ${p.bad}/${profile.overview.bad} bad, ×${p.lift})`;
  return {
    target: { genre: genre || null, subgenre: subgenre || null },
    evidence: group ? { videos: group.total, best: group.best, bad: group.bad, win_rate: group.win_rate, low_sample: group.low_sample } : null,
    duration: { target_seconds: dur.median ? Math.round(dur.median) : null, worked_range_seconds: dur.p25 && dur.p75 ? [Math.round(dur.p25), Math.round(dur.p75)] : null },
    scene_count_guidance: group?.scene_count_best ? Math.round(group.scene_count_best) : profile.overview.scene_count_best ? Math.round(profile.overview.scene_count_best) : null,
    use_patterns: patterns.winning.slice(0, 10).map(fmt),
    avoid_patterns: patterns.avoid.slice(0, 10).map(fmt),
    pattern_scope: profile.patterns.by_genre[genre] ? `within ${genre}` : "across all genres (not enough data within this genre)",
    // the team's own numbers, e.g. "Retention %: best videos median 42 vs bad 18" (context, not a target to quote)
    performance_signals: (profile.sheet_metadata?.metrics || []).filter(m => !m.low_sample && m.ratio && Math.abs(Math.log(m.ratio)) >= Math.log(1.2)).slice(0, 6)
      .map(m => `${m.label}: best videos median ${m.best.median} vs ${m.bad.median} for bad (${m.best.n}/${m.bad.n} videos)`),
    structural_examples: exemplars.map(e => ({ duration_seconds: e.duration, scene_count: e.scene_count, hook_pattern: e.story_dna.hook_pattern, story_engine: e.story_dna.story_engine, emotional_arc: e.story_dna.emotional_arc, pacing: e.story_dna.pacing, ending_type: e.story_dna.ending_type })),
    caveats: profile.notes,
  };
}
