// Generates tiny synthetic videos with the bundled ffmpeg (cached under tests/.tmp/fixtures).
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { FFMPEG_PATH, run } from "../../server/src/services/video/media.js";

const dir = path.resolve("tests/.tmp/fixtures");

async function make(name, args) {
  const out = path.join(dir, name);
  if (existsSync(out)) return out;
  mkdirSync(dir, { recursive: true });
  const { code, stderr } = await run(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args, out], { timeoutMs: 60_000 });
  if (code !== 0) throw new Error(`fixture ${name} failed: ${stderr}`);
  return out;
}

export async function mediaFixtures() {
  const withAudio = await make("with-audio.mp4", [
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  ]);
  const silent = await make("silent.mp4", ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]);
  const notVideo = path.join(dir, "not-video.mp4");
  if (!existsSync(notVideo)) writeFileSync(notVideo, "this is not a video file".repeat(100));
  return { withAudio, silent, notVideo };
}

/** n distinct short videos (different tone + length) so content-hash reuse doesn't merge them. */
export async function distinctVideos(n) {
  const out = [];
  for (let i = 0; i < n; i++)
    out.push(await make(`distinct-${i}.mp4`, ["-f", "lavfi", "-i", `testsrc=size=96x64:rate=5:duration=${2 + (i % 4)}`, "-f", "lavfi", "-i", `sine=frequency=${300 + i * 37}:duration=${2 + (i % 4)}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]));
  return out;
}
