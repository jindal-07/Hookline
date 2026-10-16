// Embedding abstraction. Vectors are L2-normalised so cosine = dot product.
// Raw cosine is NOT a probability: each provider carries a calibration (floor/ceil) that maps
// cosine into a 0..1 "semantic agreement" score. Calibrate with `npm run calibrate -w server`.

export class EmbeddingService {
  /** @returns {Promise<number[][]>} */
  async embed(texts, options = {}) { throw new Error("not implemented"); } // eslint-disable-line no-unused-vars

  async similarity(textA, textB) {
    const [a, b] = await this.embed([textA, textB]);
    return cosine(a, b);
  }

  /** { provider, model, version, multilingual, semantic, calibration: { floor, ceil } } */
  get info() { throw new Error("not implemented"); }
}

export function l2normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map(x => x / n);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Map raw cosine to 0..1 using the provider's calibration (piecewise linear, clamped). */
export function calibrate(cos, { floor, ceil }) {
  if (!Number.isFinite(cos)) return 0;
  if (cos <= floor) return 0;
  if (cos >= ceil) return 1;
  return (cos - floor) / (ceil - floor);
}

/**
 * Derive a calibration from labelled pairs: floor = 90th percentile of unrelated pairs,
 * ceil = median of related pairs. Returns null if the classes overlap too much to be useful.
 */
export function deriveCalibration(related, unrelated) {
  const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
  const floor = q(unrelated, 0.9);
  const ceil = q(related, 0.5);
  if (!(ceil > floor + 0.02)) return null;
  return { floor: Math.round(floor * 1000) / 1000, ceil: Math.round(ceil * 1000) / 1000 };
}

/**
 * Default calibrations — starting points; re-derive for your data with `npm run calibrate -w server`.
 *   local: MEASURED on shared/calibration/pairs.json with Xenova/multilingual-e5-small (q8):
 *          related 0.801–0.929, unrelated 0.685–0.798 → floor 0.795, ceil 0.86.
 *   gemini: NOT yet measured (needs a valid GEMINI_API_KEY) — provisional; run calibrate before relying on it.
 *   hash: lexical fallback; cannot separate cross-language pairs at all (MatchingService marks those INCONCLUSIVE).
 */
export const DEFAULT_CALIBRATION = {
  gemini: { floor: 0.55, ceil: 0.82 },
  local: { floor: 0.795, ceil: 0.86 },
  hash: { floor: 0.08, ceil: 0.55 },
};
