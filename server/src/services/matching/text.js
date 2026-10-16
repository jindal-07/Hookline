// Unicode-aware text utilities shared by normalisation, matching and originality checks.
// Works for Latin and Devanagari (Hindi) scripts.

const STOP = new Set((
  "a an the and or but if then so of to in on at by for with from as is are was were be been being it its this that these those " +
  "i you he she we they me him her us them my your his our their what which who whom whose do does did not no yes ok okay " +
  "will would can could should shall may might must have has had just very too also there here than into out up down over " +
  "है हैं था थी थे हो होता होती और या लेकिन तो के का की को में से पर ने भी ही यह वह ये वो मैं तुम आप हम उन उस इस एक कि नहीं हाँ हां जी"
).split(/\s+/));

/** Lowercased word tokens (letters + combining marks + digits), punctuation stripped. */
export function tokenize(text) {
  return String(text || "").toLowerCase().normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) || [];
}

export function contentTokens(text) {
  return tokenize(text).filter(t => t.length > 1 && !STOP.has(t));
}

export function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Detect the dominant writing system: "devanagari" | "latin" | "mixed" | "none". */
export function scriptOf(text) {
  const s = String(text || "");
  const dev = (s.match(/[ऀ-ॿ]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  if (!dev && !lat) return "none";
  if (dev && lat) return dev / (dev + lat) > 0.8 ? "devanagari" : lat / (dev + lat) > 0.8 ? "latin" : "mixed";
  return dev ? "devanagari" : "latin";
}
