// Opt-in: runs the matching fixtures through the REAL offline multilingual model (downloads ~120 MB once).
//   RUN_LOCAL_EMBEDDINGS=1 npx vitest run tests/integration/real-embeddings.test.js
import { describe, it, expect } from "vitest";
import { MatchingService } from "../../server/src/services/matching/MatchingService.js";
import { LocalEmbeddingService } from "../../server/src/services/embeddings/providers.js";
import { baseScreenplay, normalized, HINDI_UTTERANCES, HINGLISH_UTTERANCES, SCRAMBLED_UTTERANCES, CONTRADICTORY_UTTERANCES } from "../fixtures/matching.js";

describe.runIf(process.env.RUN_LOCAL_EMBEDDINGS === "1")("MatchingService with real multilingual-e5-small embeddings", () => {
  const svc = new MatchingService({ embeddings: new LocalEmbeddingService() });
  const run = async (u) => svc.compare({ transcript: await normalized(u), screenplayAnalysis: baseScreenplay() });
  const results = {};

  it("scores the fixture scenarios", async () => {
    for (const [k, u] of Object.entries({ hindi: HINDI_UTTERANCES, hinglish: HINGLISH_UTTERANCES, scrambled: SCRAMBLED_UTTERANCES, contradictory: CONTRADICTORY_UTTERANCES })) results[k] = await run(u);
    for (const [k, r] of Object.entries(results))
      process.stdout.write(`${k.padEnd(14)} overall ${r.overall_score?.toFixed(1)} story ${r.story_score?.toFixed(1)} char ${r.character_score?.toFixed(1)} dlg ${r.dialogue_score?.toFixed(1)} conf ${r.confidence.toFixed(2)} ${r.match_status} mismatches ${r.evidence.mismatches.length}
`);
  }, 600_000);

  it("ranks genuine matches above scrambled and contradictory transcripts", () => {
    expect(results.hindi.overall_score).toBeGreaterThan(results.scrambled.overall_score);
    expect(results.hindi.overall_score).toBeGreaterThan(results.contradictory.overall_score + 25);
    expect(results.hinglish.overall_score).toBeGreaterThan(results.contradictory.overall_score + 25);
    expect(results.contradictory.eligible).toBe(false);
  });
});
