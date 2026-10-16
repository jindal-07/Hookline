// Concrete embedding providers.
import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { EmbeddingService, l2normalize, DEFAULT_CALIBRATION } from "./EmbeddingService.js";
import { tokenize, contentTokens } from "../matching/text.js";
import { classifyError, permanent } from "../../utils/errors.js";

/** Google Gemini text embeddings (multilingual, 100+ languages). */
export class GeminiEmbeddingService extends EmbeddingService {
  constructor({ apiKey, model = "gemini-embedding-001", dimensions = 768, batchSize = 100, client, calibration } = {}) {
    super();
    if (!apiKey && !client) throw permanent("PROVIDER_NOT_CONFIGURED", "Gemini embeddings need EMBEDDING_API_KEY or GEMINI_API_KEY");
    this.ai = client || new GoogleGenAI({ apiKey });
    Object.assign(this, { model: model || "gemini-embedding-001", dimensions, batchSize, calibration: calibration || DEFAULT_CALIBRATION.gemini });
  }
  get info() {
    return { provider: "gemini", model: this.model, version: `${this.model}@${this.dimensions}`, multilingual: true, semantic: true, calibration: this.calibration };
  }
  async embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize);
      try {
        const r = await this.ai.models.embedContent({
          model: this.model,
          contents: chunk,
          config: { taskType: "SEMANTIC_SIMILARITY", outputDimensionality: this.dimensions },
        });
        out.push(...r.embeddings.map(e => l2normalize(e.values))); // reduced dims must be re-normalised
      } catch (e) {
        throw classifyError(e);
      }
    }
    return out;
  }
}

/** Offline multilingual embeddings via transformers.js (Xenova/multilingual-e5-small, ~118 MB, Hindi supported). */
export class LocalEmbeddingService extends EmbeddingService {
  constructor({ model = "Xenova/multilingual-e5-small", dtype = "q8", calibration } = {}) {
    super();
    Object.assign(this, { model: model || "Xenova/multilingual-e5-small", dtype, calibration: calibration || DEFAULT_CALIBRATION.local });
    this.pipe = null;
  }
  get info() {
    return { provider: "local", model: this.model, version: `${this.model}@${this.dtype}`, multilingual: true, semantic: true, calibration: this.calibration };
  }
  async load() {
    if (!this.pipe) {
      let mod;
      try { mod = await import("@huggingface/transformers"); }
      catch { throw permanent("PROVIDER_NOT_CONFIGURED", "EMBEDDING_PROVIDER=local needs `npm install @huggingface/transformers -w server`"); }
      this.pipe = await mod.pipeline("feature-extraction", this.model, { dtype: this.dtype });
    }
    return this.pipe;
  }
  async embed(texts) {
    const pipe = await this.load();
    // E5 requires a prefix on every input; "query: " on both sides for symmetric similarity.
    const out = await pipe(texts.map(t => `query: ${t}`), { pooling: "mean", normalize: true });
    return out.tolist();
  }
}

/**
 * Deterministic lexical fallback (hashed word + character n-grams). NOT semantic and NOT cross-lingual:
 * different wording or a Hindi transcript vs an English analysis will score low. Used for tests and when
 * no embedding provider is configured; the MatchingService lowers confidence when it is active.
 */
export class HashEmbeddingService extends EmbeddingService {
  constructor({ dimensions = 512, calibration } = {}) {
    super();
    Object.assign(this, { dimensions, calibration: calibration || DEFAULT_CALIBRATION.hash });
  }
  get info() {
    return { provider: "hash", model: "hashed-ngrams", version: `hash-v1@${this.dimensions}`, multilingual: false, semantic: false, calibration: this.calibration };
  }
  async embed(texts) {
    return texts.map(t => {
      const v = new Array(this.dimensions).fill(0);
      const add = (feat, w) => {
        const h = createHash("md5").update(feat).digest();
        const idx = h.readUInt32LE(0) % this.dimensions;
        v[idx] += (h[4] & 1 ? 1 : -1) * w;
      };
      for (const w of contentTokens(t)) {
        add(`w:${w}`, 1);
        const padded = `#${w}#`;
        for (let i = 0; i + 3 <= padded.length; i++) add(`c:${padded.slice(i, i + 3)}`, 0.35);
      }
      const toks = tokenize(t);
      for (let i = 0; i + 2 <= toks.length; i++) add(`b:${toks[i]} ${toks[i + 1]}`, 0.5);
      return l2normalize(v);
    });
  }
}
