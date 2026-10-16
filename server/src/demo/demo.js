// `npm run demo` — runs the complete app with NO external services:
//   • real PostgreSQL via embedded-postgres (stored in server/storage/demo-pg)
//   • in-process queue (QUEUE_DRIVER=memory)
//   • the real pipeline, MatchingService, Story DNA, originality checks and dashboard
//   • MOCK downloader / transcriber / Gemini analyzer / skill, fed by built-in fixtures
// Everything mock-generated is labelled as such. Use the generated sample spreadsheet to try it.
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const STORE = path.join(ROOT, "server", "storage");
const PG_DIR = path.join(STORE, "demo-pg");
const PORT = Number(process.env.DEMO_PG_PORT || 54330);

// Configuration must be in place before any app module reads it.
Object.assign(process.env, {
  NODE_ENV: "development",
  DATABASE_URL: `postgres://postgres:postgres@localhost:${PORT}/reelscript_demo`,
  DATABASE_URL_UNPOOLED: "", DB_SSL: "", // never touch the Neon database configured in .env
  QUEUE_DRIVER: "memory",
  DOWNLOADER: "mock", TRANSCRIBER: "mock", ANALYZER: "mock", EMBEDDING_PROVIDER: "hash", SKILL_MODE: "mock",
  TEMP_VIDEO_DIR: "server/storage/demo/videos", TEMP_AUDIO_DIR: "server/storage/demo/audio", SKILL_EXCHANGE_DIR: "server/storage/demo/skill-exchange",
  CORS_ORIGIN: "http://localhost:5173",
});
process.env.PORT ||= "5000";

const { default: EmbeddedPostgres } = await import("embedded-postgres");
const firstRun = !existsSync(PG_DIR);
const pg = new EmbeddedPostgres({ databaseDir: PG_DIR, user: "postgres", password: "postgres", port: PORT, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
// Reuse an instance left running by a previous hard-killed demo; otherwise start one.
const { default: pgLib } = await import("pg");
const reachable = async () => {
  const c = new pgLib.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
};
let startedHere = false;
if (!(await reachable())) {
  if (firstRun) await pg.initialise();
  await pg.start();
  startedHere = true;
  if (firstRun) await pg.createDatabase("reelscript_demo");
}

// ---- demo providers ----
const { setProviders } = await import("../services/registry.js");
const { MockDownloader } = await import("../services/video/VideoDownloader.js");
const { AudioExtractor } = await import("../services/audio/AudioExtractor.js");
const { MockTranscriber } = await import("../services/transcription/AssemblyAITranscriber.js");
const { MockVideoAnalyzer } = await import("../services/screenplay/GeminiVideoAnalyzer.js");
const { MockSkillAdapter } = await import("../services/generation/skillAdapters.js");
const { CachedEmbeddingService } = await import("../services/embeddings/CachedEmbeddingService.js");
const { ConceptEmbeddingService } = await import("./conceptEmbeddings.js");
const F = await import("./fixtures.js");
const { FFMPEG_PATH, run } = await import("../services/video/media.js");

const media = path.join(STORE, "demo", "fixtures");
mkdirSync(media, { recursive: true });
const make = async (name, args) => {
  const out = path.join(media, name);
  if (!existsSync(out)) await run(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args, out], { timeoutMs: 60_000 });
  return out;
};
const withAudio = await make("with-audio.mp4", ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=60", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
const silent = await make("silent.mp4", ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]);
// Each training video needs distinct content — identical files are (correctly) treated as the same video and reused.
const clip = (secs, n) => make(`clip-${n}-${secs}s.mp4`, ["-f", "lavfi", "-i", `testsrc=size=128x96:rate=4:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=${250 + n * 23}:duration=${secs}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);

const U = (n) => `https://www.facebook.com/reel/90000000000${n}`;
const silentScreenplay = F.baseScreenplay({ dialogue_moments: [] });
silentScreenplay.scenes.forEach(s => { s.dialogue_summary = ""; });

// Slow the mocks down a little so progress is visible in the dashboard.
const delay = (fn, ms) => async (...a) => { await new Promise(r => setTimeout(r, ms + Math.random() * ms)); return fn(...a); };
const downloader = new MockDownloader({ outputDir: path.join(STORE, "demo", "videos"), defaultFixture: withAudio, fixtures: { [U(5)]: { error: "VIDEO_PRIVATE", message: "The video is private or requires login. (demo)" }, [U(6)]: silent } });
downloader.download = delay(downloader.download.bind(downloader), 900);
const transcriber = new MockTranscriber({
  defaultFixture: F.rawTranscript(F.HINDI_UTTERANCES),
  fixtures: { [U(2)]: F.rawTranscript(F.HINGLISH_UTTERANCES), [U(3)]: F.rawTranscript(F.CONTRADICTORY_UTTERANCES), [U(4)]: F.rawTranscript(F.SCRAMBLED_UTTERANCES) },
});
transcriber.transcribe = delay(transcriber.transcribe.bind(transcriber), 900);
// ---- training dataset (20 labelled videos) ----
const T = (n) => `https://www.facebook.com/reel/8000000000${String(n).padStart(2, "0")}`;
const variant = (genre, subgenre, { good }) => {
  const a = F.baseScreenplay();
  a.metadata = { ...a.metadata, genre, subgenre };
  if (!good) {
    a.hook = { ...a.hook, opening_visual: "Two people argue loudly", attention_element: "Shouting match", curiosity_mechanism: "An ongoing argument", initial_question: "" };
    a.story_structure = a.story_structure.map(e => (e.element === "resolution" ? { ...e, status: "absent" } : e));
    a.emotional_arc = { stages: ["annoyance", "boredom", "confusion"], summary: "Flat" };
    a.dialogue_moments = a.dialogue_moments.map(m => ({ ...m, intent: "inform", is_reveal: false }));
  }
  return a;
};
const training = [
  ...[0, 1, 2, 3, 4, 5, 6].map(i => ({ n: i, label: "best", genre: "Drama", sub: "Family Drama", secs: [45, 58, 58, 72, 58, 45, 72][i], views: 900000 - i * 40000 })),
  ...[7, 8, 9].map(i => ({ n: i, label: "best", genre: "Romance", sub: "Workplace Romance", secs: 58, views: 600000 - i * 10000 })),
  ...[10, 11, 12, 13, 14, 15].map(i => ({ n: i, label: "bad", genre: "Comedy", sub: "Office Comedy", secs: i % 2 ? 145 : 170, views: 4000 + i * 100 })),
  ...[16, 17].map(i => ({ n: i, label: "bad", genre: "Drama", sub: "Family Drama", secs: 170, views: 6000 })),
  ...[18, 19].map(i => ({ n: i, label: "bad", genre: "Thriller", sub: "Revenge Thriller", secs: 145, views: 3000 })),
];
const trainingAnalyses = Object.fromEntries(training.map(t => [T(t.n), variant(t.genre, t.sub, { good: t.label === "best" })]));
const trainingVideos = {};
for (const t of training) trainingVideos[T(t.n)] = await clip(t.secs, t.n);

const analyzer = new MockVideoAnalyzer({ defaultFixture: F.baseScreenplay(), fixtures: { [U(6)]: silentScreenplay, ...trainingAnalyses } });
Object.assign(downloader.fixtures, trainingVideos);
analyzer.analyzeVideo = delay(analyzer.analyzeVideo.bind(analyzer), 1200);
const skill = new MockSkillAdapter();
skill.invoke = delay(skill.invoke.bind(skill), 1500);

const { initDatabase } = await import("../models/index.js");
const { models } = await initDatabase(process.env.DATABASE_URL);
setProviders({
  downloader, transcriber, analyzer, skillAdapter: skill,
  audioExtractor: new AudioExtractor({ outputDir: path.join(STORE, "demo", "audio") }),
  embeddings: new CachedEmbeddingService({ inner: new ConceptEmbeddingService(), model: models.EmbeddingCache }),
});

// Sample spreadsheet to upload
const XLSX = await import("xlsx");
const sample = path.join(STORE, "demo", "sample-videos.xlsx");
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ["video_url", "title", "category", "views", "likes", "shares", "comments"],
  [U(1), "Kya Naukrani IAS Ban Paegi? (Hindi)", "Drama", 1250000, 84000, 12000, 3100],
  [U(2), "Maid's dream (Hinglish cut)", "Drama", 640000, 31000, 5200, 900],
  [U(3), "Unrelated audio track", "Comedy", 98000, 2100, 140, 60],
  [U(4), "Re-edited version", "Drama", 210000, 9000, 800, 210],
  [U(5), "Private reel", "Drama", "", "", "", ""],
  [U(6), "Silent montage", "Lifestyle", 45000, 1200, 90, 12],
  [U(1) + "?mibextid=abc", "Duplicate of row 2", "Drama", "", "", "", ""],
  ["https://www.youtube.com/watch?v=xyz", "Wrong platform", "", "", "", "", ""],
]), "Videos");
writeFileSync(sample, Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })));
const trainingSheet = path.join(STORE, "demo", "training-videos.xlsx");
const twb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(twb, XLSX.utils.aoa_to_sheet([
  ["video_url", "title", "performance", "views"],
  ...training.map(t => [T(t.n), `${t.sub} #${t.n + 1} (demo)`, t.label, t.views]),
]), "Training");
writeFileSync(trainingSheet, Buffer.from(XLSX.write(twb, { type: "buffer", bookType: "xlsx" })));

console.log(`
  ┌───────────────────────────────────────────────────────────────┐
  │  Hookline DEMO — mock providers, embedded PostgreSQL           │
  │  Dashboard (after \`npm run dev:client\`):  http://localhost:5173 │
  │  or built UI served at:                   http://127.0.0.1:${process.env.PORT}  │
  │  Sample spreadsheet: server/storage/demo/sample-videos.xlsx    │
  │  Training sample:    server/storage/demo/training-videos.xlsx  │
  └───────────────────────────────────────────────────────────────┘
`);

globalThis.__reelscriptShutdownHook = async () => { if (startedHere) try { await pg.stop(); } catch { /* already stopped */ } };
await import("../index.js");
