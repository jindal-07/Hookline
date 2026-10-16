// Wires the real orchestrator to mocked providers + the in-memory queue for integration tests.
import path from "node:path";
import { setupTestDb, resetDb } from "./db.js";
import { initQueues, queues, closeQueues } from "../../server/src/queues/index.js";
import { startWorkers, stopWorkers } from "../../server/src/workers/index.js";
import { setProviders } from "../../server/src/services/registry.js";
import { MockDownloader } from "../../server/src/services/video/VideoDownloader.js";
import { AudioExtractor } from "../../server/src/services/audio/AudioExtractor.js";
import { MockTranscriber } from "../../server/src/services/transcription/AssemblyAITranscriber.js";
import { MockVideoAnalyzer } from "../../server/src/services/screenplay/GeminiVideoAnalyzer.js";
import { MockSkillAdapter } from "../../server/src/services/generation/skillAdapters.js";
import { CachedEmbeddingService } from "../../server/src/services/embeddings/CachedEmbeddingService.js";
import { ConceptEmbeddingService } from "../fixtures/concept-embeddings.js";
import { mediaFixtures } from "../fixtures/media.js";
import { baseScreenplay, rawTranscript, HINDI_UTTERANCES } from "../fixtures/matching.js";

export const URLS = {
  good: "https://www.facebook.com/reel/1000000000001",
  good2: "https://www.facebook.com/reel/1000000000002",
  private: "https://www.facebook.com/reel/1000000000003",
  flaky: "https://www.facebook.com/reel/1000000000004",
  silent: "https://www.facebook.com/reel/1000000000005",
};

export async function setupPipeline(overrides = {}) {
  const ctx = await setupTestDb();
  await resetDb();
  const fx = await mediaFixtures();
  const tmp = path.resolve("tests/.tmp/pipeline");
  const raw = rawTranscript(HINDI_UTTERANCES);
  const p = {
    downloader: new MockDownloader({
      outputDir: path.join(tmp, "videos"),
      defaultFixture: fx.withAudio,
      fixtures: { [URLS.private]: { error: "VIDEO_PRIVATE", message: "The video is private" }, [URLS.silent]: fx.silent },
    }),
    audioExtractor: new AudioExtractor({ outputDir: path.join(tmp, "audio") }),
    transcriber: new MockTranscriber({ defaultFixture: raw }),
    analyzer: new MockVideoAnalyzer({ defaultFixture: baseScreenplay() }),
    embeddings: new CachedEmbeddingService({ inner: new ConceptEmbeddingService(), model: ctx.models.EmbeddingCache }),
    skillAdapter: new MockSkillAdapter(),
    ...overrides,
  };
  setProviders(p);
  await closeQueues();
  await initQueues({ backoffScale: 0.001 }); // retries in milliseconds
  await startWorkers({ recover: false, sweepEveryMs: 0 });
  return { ctx, providers: p, fx, drain: () => queues().drain() };
}

export async function teardownPipeline() {
  stopWorkers();
  await closeQueues();
  setProviders({});
}

/** Create a batch with videos directly (bypassing upload). */
export async function makeBatch(models, urls, { filename = "t.xlsx" } = {}) {
  const batch = await models.Batch.create({ filename });
  const videos = [];
  for (const [i, u] of urls.entries())
    videos.push(await models.Video.create({ batch_id: batch.id, video_url: u, normalized_url: u, source_row_number: i + 2, category: i % 2 ? "Comedy" : "Drama" }));
  return { batch, videos };
}
