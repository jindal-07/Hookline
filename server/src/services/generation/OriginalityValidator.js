// Deterministic originality checks for generated scripts: rejects copied phrasing, reused names,
// distinctive source lines and scene-by-scene paraphrase. Treats the script as untrusted text.
import { tokenize, ngrams } from "../matching/text.js";
import { cosine, calibrate } from "../embeddings/EmbeddingService.js";

const GENERIC = /^(the |a |an )?(man|woman|boy|girl|child|old|young|elderly|older|younger|maid|servant|driver|guard|officer|police|doctor|teacher|boss|employee|customer|stranger|friend|husband|wife|mother|father|son|daughter|brother|sister|person|narrator|guest|neighbou?r)\b/i;

const HONORIFIC = new Set(["mrs", "mr", "ms", "miss", "dr", "sir", "madam", "madame", "ji", "saab", "sahab", "shri", "smt", "uncle", "aunty", "auntie"]);

// Role words that analysts use as labels for unnamed characters ("Manager", "Nurse Pam", "Sergeant Green").
// They are not names: only the remaining proper-noun words of a label count as a character name.
const ROLE_WORDS = new Set(`the and his her their my our your this that manager dad daddy mom mommy mum mummy baby chief nurse lawyer attorney cleaner janitor suit boyfriend girlfriend
coworker co worker hr pizza waiter waitress cashier clerk owner captain sergeant sgt lieutenant lt detective det judge landlord landlady tenant
realtor receptionist security agent cop sheriff deputy principal student kid kids grandma grandpa grandmother grandfather client patient worker
supervisor ceo assistant blonde brunette redhead street new first second third other partner fiance fiancee ex mistress lover rich poor homeless
bodyguard soldier military robber thief suspect victim witness passenger chef cook bartender host hostess nanny babysitter stepdad stepmom
stepfather stepmother aunt cousin niece nephew teen teenager toddler infant elder senior junior bystander crowd staff team member coach player fan
vendor seller buyer tourist traveler traveller resident local villager group couple family parent parents in law sir officer man woman boy girl
child old young elderly maid servant driver guard police doctor teacher boss employee customer stranger friend husband wife mother father son
daughter brother sister person narrator guest neighbor neighbour voice crew lady gentleman guy dude bro buddy pal`.split(/\s+/));

const LATIN = /^[A-Za-z][A-Za-z'’-]*$/;

/** Proper-noun words of a character label: "Manager (Mr. Johnson)" → ["Johnson"], "Hope Long" → ["Hope", "Long"]. */
export function nameWords(label) {
  return String(label || "")
    .split(/[^\p{L}\p{M}'’-]+/u)
    .filter(Boolean)
    .filter(w => {
      const lower = w.toLowerCase();
      if (w.length < 3 || HONORIFIC.has(lower) || ROLE_WORDS.has(lower)) return false;
      // Latin words must be written as a proper noun in the label (capitalised); other scripts have no case.
      return LATIN.test(w) ? /^[A-Z]/.test(w) : true;
    });
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SENTENCE_START = /(?:^|[.!?…:]\s+|\n\s*|["“(]\s*|\*\*\s*)$/;
const AFTER_ARTICLE = /(?:^|[^A-Za-z])(?:the|a|an)\s+$/i;

/**
 * Where the script uses this name word as a name (capitalised or in capitals), not as an ordinary word.
 * For words of multi-word names ("Hope Long"), a capitalised word that merely starts a sentence ("Long before…")
 * or follows an article ("The Long Night") doesn't count; all-caps and other mid-sentence uses do.
 * Shared with the name repair, so the check and the fix agree on what is a name.
 * @returns {{ index: number, text: string }[]}
 */
export function nameMatches(text, word, { multiWord = false } = {}) {
  if (!LATIN.test(word)) return [];
  const cap = word[0].toUpperCase() + word.slice(1).toLowerCase();
  const upper = word.toUpperCase();
  const re = new RegExp(`(?<![A-Za-z])(?:${escapeRe(cap)}|${escapeRe(upper)})(?![A-Za-z])`, "g");
  const out = [];
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (multiWord && m[0] !== upper && (SENTENCE_START.test(before) || AFTER_ARTICLE.test(before))) continue;
    out.push({ index: m.index, text: m[0] });
  }
  return out;
}

function usesName(text, tokenSet, word, { multiWord = false } = {}) {
  if (!LATIN.test(word)) return tokenSet.has(word.toLowerCase());
  return nameMatches(text, word, { multiWord }).length > 0;
}

export const ORIGINALITY_DEFAULTS = {
  maxSharedRun: 7,          // longest run of consecutive tokens shared with any source line
  maxFiveGramOverlap: 0.04, // share of the script's 5-grams that also occur in the source
  paraphraseAgreement: 0.9, // calibrated similarity that counts a scene as a paraphrase
  maxParaphraseShare: 0.6,  // fraction of scenes that may closely track source scenes in order
  minLength: 200,
  maxLength: 60_000,
};

export class OriginalityValidator {
  constructor({ embeddings = null, options = {} } = {}) {
    this.embeddings = embeddings;
    this.o = { ...ORIGINALITY_DEFAULTS, ...options };
  }

  /**
   * @param {string} script
   * @param {{ transcript?: object, analysis?: object, storyDna?: object }} source
   * @returns {Promise<{ passed: boolean, issues: object[], metrics: object }>}
   */
  async validate(script, { transcript, analysis, storyDna } = {}) {
    const issues = [];
    const text = String(script || "");
    if (text.trim().length < this.o.minLength) issues.push({ code: "TOO_SHORT", message: `Script is shorter than ${this.o.minLength} characters` });
    if (text.length > this.o.maxLength) issues.push({ code: "TOO_LONG", message: `Script exceeds ${this.o.maxLength} characters` });

    const sourceLines = [
      ...(transcript ? [...(transcript.dialogue_segments || []), ...(transcript.narration_segments || []), ...(transcript.uncertain_segments || [])].map(s => s.text) : []),
      ...(analysis ? analysis.dialogue_moments.map(m => m.summary) : []),
      ...(analysis ? analysis.visual_storytelling.text_overlays.map(t => t.detail) : []),
    ].filter(Boolean);

    // 1. Long verbatim runs + 5-gram overlap
    const scriptTokens = tokenize(text);
    const longest = longestSharedRun(scriptTokens, sourceLines.map(tokenize));
    if (longest.length > this.o.maxSharedRun) issues.push({ code: "COPIED_PHRASE", message: `Reuses a ${longest.length}-word run from the source: "${longest.run.slice(0, 120)}"` });
    const src5 = new Set(sourceLines.flatMap(l => ngrams(tokenize(l), 5)));
    const s5 = ngrams(scriptTokens, 5);
    const overlap = s5.length ? s5.filter(g => src5.has(g)).length / s5.length : 0;
    if (overlap > this.o.maxFiveGramOverlap) issues.push({ code: "HIGH_OVERLAP", message: `${(overlap * 100).toFixed(1)}% of the script's 5-word sequences occur in the source` });

    // 2. Reused character names
    const tokenSet = new Set(scriptTokens);
    const names = (analysis?.characters || []).map(c => c.label).filter(l => l && !GENERIC.test(l));
    const reused = names.filter(n => {
      const words = nameWords(n);
      const full = words.length > 1 && new RegExp(`(?<![A-Za-z])${words.map(escapeRe).join("\\s+")}(?![A-Za-z])`, "i").test(text);
      return full || words.some(w => usesName(text, tokenSet, w, { multiWord: words.length > 1 }));
    });
    if (reused.length) issues.push({ code: "REUSED_NAMES", message: `Reuses source character names: ${reused.join(", ")}` });

    // 3. Distinctive phrases from the Story DNA "avoid" list
    const avoided = (storyDna?.avoid || [])
      .map(a => a.match(/^(?:phrase|line) "(.+?)(?:\.\.\.)?"$/)?.[1])
      .filter(Boolean)
      .filter(p => { const t = tokenize(p); return t.length >= 3 && containsSequence(scriptTokens, t.slice(0, Math.min(t.length, 6))); });
    if (avoided.length) issues.push({ code: "SIGNATURE_LINE", message: `Contains distinctive source lines: ${avoided.map(a => `"${a}"`).join(", ")}` });

    // 4. Scene-by-scene paraphrase (semantic; needs an embedding provider)
    let paraphraseShare = null;
    if (this.embeddings && analysis?.scenes?.length) {
      const scriptScenes = splitScenes(text);
      if (scriptScenes.length >= 2) {
        const srcScenes = analysis.scenes.map(s => [s.visual_description, s.dialogue_summary, ...s.actions].filter(Boolean).join(". "));
        const vecs = await this.embeddings.embed([...scriptScenes, ...srcScenes]);
        const a = vecs.slice(0, scriptScenes.length), b = vecs.slice(scriptScenes.length);
        const cal = this.embeddings.info.calibration;
        let lastIdx = -1, tracked = 0;
        for (const v of a) {
          let best = -1, bestIdx = -1;
          b.forEach((w, i) => { const s = calibrate(cosine(v, w), cal); if (s > best) { best = s; bestIdx = i; } });
          if (best >= this.o.paraphraseAgreement && bestIdx > lastIdx) { tracked++; lastIdx = bestIdx; }
        }
        paraphraseShare = tracked / scriptScenes.length;
        if (paraphraseShare > this.o.maxParaphraseShare && tracked >= 2)
          issues.push({ code: "SCENE_PARAPHRASE", message: `${tracked} of ${scriptScenes.length} scenes closely track the source scenes in order` });
      }
    }

    return {
      passed: issues.length === 0,
      issues,
      metrics: { longest_shared_run: longest.length, five_gram_overlap: Math.round(overlap * 1000) / 1000, reused_names: reused, paraphrase_share: paraphraseShare, length: text.length },
    };
  }
}

function longestSharedRun(a, sources) {
  let best = { length: 0, run: "" };
  for (const b of sources) {
    if (!b.length) continue;
    // DP longest common substring over tokens
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      const cur = new Array(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j++) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best.length) best = { length: cur[j], run: a.slice(i - cur[j], i).join(" ") };
        }
      }
      prev = cur;
    }
  }
  return best;
}

function containsSequence(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Split on screenplay sluglines (INT./EXT.) or "SCENE n" headings. */
export function splitScenes(text) {
  const parts = String(text).split(/\n(?=\s*(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.|SCENE\s+\d+|#+\s*Scene))/i).map(s => s.trim()).filter(s => s.length > 20);
  return parts.length ? parts : [String(text)];
}
