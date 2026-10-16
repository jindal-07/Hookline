// Caches embeddings by (normalised text, provider, model, model version): in memory and in Postgres.
import { createHash } from "node:crypto";
import { EmbeddingService } from "./EmbeddingService.js";

const normalizeText = t => String(t ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

export class CachedEmbeddingService extends EmbeddingService {
  /** @param {{ inner: EmbeddingService, model?: import('sequelize').ModelStatic<any>, memoryLimit?: number }} opts */
  constructor({ inner, model = null, memoryLimit = 20_000 }) {
    super();
    Object.assign(this, { inner, dbModel: model, memoryLimit });
    this.memory = new Map();
    this.stats = { hits: 0, misses: 0, dbHits: 0 };
  }
  get info() { return this.inner.info; }

  key(text) {
    const { provider, model, version } = this.inner.info;
    return createHash("sha256").update(`${provider}\u0000${model}\u0000${version}\u0000${normalizeText(text)}`).digest("hex");
  }

  async embed(texts) {
    const norm = texts.map(normalizeText);
    const keys = norm.map(t => this.key(t));
    const result = new Array(texts.length);
    const missing = new Map(); // key -> text

    keys.forEach((k, i) => {
      if (this.memory.has(k)) { result[i] = this.memory.get(k); this.stats.hits++; }
      else missing.set(k, norm[i]);
    });

    if (missing.size && this.dbModel) {
      const { provider, model, version } = this.inner.info;
      const rows = await this.dbModel.findAll({ where: { text_hash: [...missing.keys()], provider, model, model_version: version } });
      for (const r of rows) { this.remember(r.text_hash, r.vector); missing.delete(r.text_hash); this.stats.dbHits++; }
    }

    if (missing.size) {
      const entries = [...missing.entries()];
      const vectors = await this.inner.embed(entries.map(([, t]) => t));
      this.stats.misses += entries.length;
      entries.forEach(([k], i) => this.remember(k, vectors[i]));
      if (this.dbModel) {
        const { provider, model, version } = this.inner.info;
        await this.dbModel.bulkCreate(entries.map(([k], i) => ({ text_hash: k, provider, model, model_version: version, dimensions: vectors[i].length, vector: vectors[i] })), { ignoreDuplicates: true });
      }
    }

    keys.forEach((k, i) => { if (!result[i]) result[i] = this.memory.get(k); });
    return result;
  }

  remember(k, v) {
    if (this.memory.size >= this.memoryLimit) this.memory.delete(this.memory.keys().next().value);
    this.memory.set(k, v);
  }
}
