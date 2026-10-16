// Derive an embedding calibration from labelled pairs with the CONFIGURED embedding provider.
//   npm run calibrate -w server [-- path/to/pairs.json]
// Prints raw cosine distributions and a suggested EMBEDDING_CALIBRATION=floor,ceil for .env.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../config/env.js";
import { providers } from "../services/registry.js";
import { cosine, deriveCalibration } from "../services/embeddings/EmbeddingService.js";

const file = process.argv[2] || path.join(ROOT_DIR, "shared", "calibration", "pairs.json");
const { related, unrelated } = JSON.parse(readFileSync(file, "utf8"));
const emb = providers.embeddings();
console.log(`Provider: ${emb.info.provider} / ${emb.info.model} (${emb.info.version})`);

async function sims(pairs) {
  const vecs = await emb.embed(pairs.flat());
  return pairs.map((_, i) => cosine(vecs[2 * i], vecs[2 * i + 1]));
}
const r = await sims(related), u = await sims(unrelated);
const fmt = a => a.map(x => x.toFixed(3)).join(" ");
const stat = a => { const s = [...a].sort((x, y) => x - y); return `min ${s[0].toFixed(3)}  median ${s[Math.floor(s.length / 2)].toFixed(3)}  max ${s.at(-1).toFixed(3)}`; };
console.log(`\nrelated   (${r.length}): ${stat(r)}\n  ${fmt(r)}`);
console.log(`unrelated (${u.length}): ${stat(u)}\n  ${fmt(u)}`);
const cal = deriveCalibration(r, u);
if (!cal) {
  console.log("\nThe related and unrelated distributions overlap too much — this provider cannot separate them reliably.");
  if (!emb.info.semantic) console.log("(Expected for the lexical 'hash' fallback with cross-language pairs. Use EMBEDDING_PROVIDER=gemini or local.)");
  process.exit(1);
}
const correct = r.filter(x => x > cal.floor).length + u.filter(x => x <= cal.floor).length;
console.log(`\nSuggested calibration: floor ${cal.floor}, ceil ${cal.ceil}  (separates ${correct}/${r.length + u.length} pairs at the floor)`);
console.log(`Add to .env:\n  EMBEDDING_CALIBRATION=${cal.floor},${cal.ceil}`);
console.log(`Current default for ${emb.info.provider}: floor ${emb.info.calibration.floor}, ceil ${emb.info.calibration.ceil}`);
