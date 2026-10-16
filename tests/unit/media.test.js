import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import { mediaFixtures } from "../fixtures/media.js";
import { AudioExtractor } from "../../server/src/services/audio/AudioExtractor.js";
import { MockDownloader, UnavailableDownloader, classifyYtDlpError } from "../../server/src/services/video/VideoDownloader.js";
import { probe } from "../../server/src/services/video/media.js";

const tmp = path.resolve("tests/.tmp/media-test");
let fx;
beforeAll(async () => { fx = await mediaFixtures(); }, 120_000);

describe("AudioExtractor", () => {
  it("extracts 16 kHz mono FLAC that AssemblyAI accepts", async () => {
    const ex = new AudioExtractor({ outputDir: path.join(tmp, "audio") });
    const r = await ex.extract(fx.withAudio, { videoId: "vid_audio" });
    expect(r.hasAudio).toBe(true);
    expect(r.audioPath).toMatch(/vid_audio\.flac$/);
    const info = await probe(r.audioPath);
    expect(info.audio).toMatchObject({ codec: "flac", sampleRate: 16000, channels: 1 });
    expect(r.durationSeconds).toBeGreaterThan(2.5);
  });

  it("handles videos without audio without failing", async () => {
    const r = await new AudioExtractor({ outputDir: path.join(tmp, "audio") }).extract(fx.silent, { videoId: "vid_silent" });
    expect(r).toMatchObject({ hasAudio: false, audioPath: null });
  });

  it("fails permanently on non-media input", async () => {
    await expect(new AudioExtractor({ outputDir: path.join(tmp, "audio") }).extract(fx.notVideo, { videoId: "bad" }))
      .rejects.toMatchObject({ code: "INVALID_MEDIA", permanent: true });
  });
});

describe("Downloaders", () => {
  it("mock downloader validates and stores the file under the video id", async () => {
    const d = new MockDownloader({ outputDir: path.join(tmp, "videos"), defaultFixture: fx.withAudio });
    const r = await d.download("https://www.facebook.com/reel/1234567890123", { videoId: "v-123" });
    expect(r.filePath).toContain("v-123");
    expect(existsSync(r.filePath)).toBe(true);
    expect(r.hasAudio).toBe(true);
  });

  it("rejects downloaded files that are not video or exceed limits", async () => {
    const d = new MockDownloader({ outputDir: path.join(tmp, "videos"), defaultFixture: fx.notVideo });
    await expect(d.download("u", { videoId: "x1" })).rejects.toMatchObject({ code: "INVALID_MEDIA" });
    const long = new MockDownloader({ outputDir: path.join(tmp, "videos"), defaultFixture: fx.withAudio, maxDurationSeconds: 1 });
    await expect(long.download("u", { videoId: "x2" })).rejects.toMatchObject({ code: "VIDEO_TOO_LONG", permanent: true });
    const big = new MockDownloader({ outputDir: path.join(tmp, "videos"), defaultFixture: fx.withAudio, maxSizeBytes: 100 });
    await expect(big.download("u", { videoId: "x3" })).rejects.toMatchObject({ code: "VIDEO_TOO_LARGE" });
  });

  it("reports scripted provider failures and the not-configured case honestly", async () => {
    const d = new MockDownloader({ outputDir: tmp, fixtures: { p: { error: "VIDEO_PRIVATE" } } });
    await expect(d.download("p", { videoId: "p" })).rejects.toMatchObject({ code: "VIDEO_PRIVATE", permanent: true });
    await expect(new UnavailableDownloader().download("u")).rejects.toMatchObject({ code: "DOWNLOADER_NOT_CONFIGURED" });
  });

  it("classifies yt-dlp errors into permanent and transient", () => {
    const c = (s) => { const e = classifyYtDlpError(s); return [e.code, e.permanent]; };
    expect(c("ERROR: [facebook] 123: This video is private")).toEqual(["VIDEO_PRIVATE", true]);
    expect(c("ERROR: [facebook] 123: Video unavailable")).toEqual(["VIDEO_UNAVAILABLE", true]);
    expect(c("ERROR: Unsupported URL: https://x")).toEqual(["UNSUPPORTED_URL", true]);
    expect(c("ERROR: HTTP Error 429: Too Many Requests")).toEqual(["RATE_LIMITED", false]);
    expect(c("ERROR: Read timed out")).toEqual(["NETWORK", false]);
    expect(c("something odd")).toEqual(["DOWNLOAD_FAILED", false]);
  });
});
