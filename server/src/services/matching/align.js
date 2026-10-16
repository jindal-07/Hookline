// Alignment primitives: transcript windows, timestamp-aware best match, order concordance.
import { cosine, calibrate } from "../embeddings/EmbeddingService.js";

/** Sliding windows over spoken segments: singles plus up to 3 consecutive segments spanning ≤ maxSpan seconds. */
export function buildWindows(segments, { maxSegments = 3, maxSpan = 15 } = {}) {
  const windows = [];
  const seen = new Set();
  for (let i = 0; i < segments.length; i++) {
    for (let j = i; j < Math.min(segments.length, i + maxSegments); j++) {
      if (segments[j].end_time - segments[i].start_time > maxSpan && j > i) break;
      const parts = segments.slice(i, j + 1);
      const text = parts.map(p => p.text).join(" ");
      if (seen.has(text)) continue;
      seen.add(text);
      windows.push({
        id: `W${windows.length + 1}`,
        start: parts[0].start_time,
        end: parts.at(-1).end_time,
        text,
        segment_ids: parts.map(p => p.segment_id),
        speakers: [...new Set(parts.map(p => p.speaker_id))],
      });
    }
  }
  return windows;
}

/** Does any spoken segment fall within [t - before, t + after]? */
export function speechNear(segments, t, before = 6, after = 10) {
  return segments.some(s => s.end_time >= t - before && s.start_time <= t + after);
}

export function segmentsIn(segments, start, end) {
  return segments.filter(s => s.end_time > start && s.start_time < end);
}

/**
 * Best transcript window for a vector. When `around` is given, windows farther than `radius` seconds
 * are discounted (timing is evidence, but transcripts and visual timestamps drift).
 * Returns { window, raw, calibrated, adjusted, distance }.
 */
export function bestMatch(vec, windows, vecOf, calibration, { around = null, radius = 10 } = {}) {
  let best = null;
  for (const w of windows) {
    const raw = cosine(vec, vecOf(w.text));
    const cal = calibrate(raw, calibration);
    let factor = 1, distance = 0;
    if (around !== null) {
      distance = around < w.start ? w.start - around : around > w.end ? around - w.end : 0;
      factor = distance <= radius ? 1 : Math.max(0.6, 1 - (distance - radius) / 60);
    }
    const adjusted = cal * factor;
    if (!best || adjusted > best.adjusted || (adjusted === best.adjusted && w.start < best.window.start))
      best = { window: w, raw, calibrated: cal, adjusted, distance };
  }
  return best;
}

/** Fraction of concordant pairs between expected order and matched positions (ties = half). Needs ≥ 3 items. */
export function orderConcordance(positions) {
  if (positions.length < 3) return null;
  let concordant = 0, total = 0;
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++) {
      total++;
      if (positions[j] > positions[i]) concordant++;
      else if (positions[j] === positions[i]) concordant += 0.5;
    }
  return total ? concordant / total : null;
}

/** Weighted mean over components whose value is not null; returns null if none are available. */
export function weightedMean(parts) {
  let sum = 0, w = 0;
  for (const [value, weight] of parts) if (value !== null && value !== undefined && Number.isFinite(value)) { sum += value * weight; w += weight; }
  return w ? sum / w : null;
}

export const round3 = n => (n === null || n === undefined ? null : Math.round(n * 1000) / 1000);
