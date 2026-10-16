// Media helpers: ffprobe inspection, hashing, safe filenames, process execution with timeouts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { permanent, transient } from "../../utils/errors.js";

export const FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegStatic;
export const FFPROBE_PATH = process.env.FFPROBE_PATH || ffprobeStatic.path;

/** Filesystem-safe name derived from an id (never from user input like titles). */
export const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);

/** Run a binary with argv (no shell), a hard timeout and bounded output capture. */
export function run(cmd, args, { timeoutMs = 120_000, maxOutput = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false;
    const cap = (buf, chunk) => (buf.length < maxOutput ? buf + chunk : buf);
    child.stdout.on("data", d => { stdout = cap(stdout, d.toString()); });
    child.stderr.on("data", d => { stderr = cap(stderr, d.toString()); });
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (killed) return reject(transient("TIMEOUT", `${cmd.split(/[\\/]/).pop()} timed out after ${Math.round(timeoutMs / 1000)}s`));
      resolve({ code, stdout, stderr });
    });
  });
}

/** ffprobe a media file → { durationSeconds, sizeBytes, formatName, hasVideo, hasAudio, video, audio } */
export async function probe(filePath, { timeoutMs = 60_000 } = {}) {
  const { code, stdout, stderr } = await run(FFPROBE_PATH, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], { timeoutMs });
  if (code !== 0) throw permanent("INVALID_MEDIA", `ffprobe could not read the file: ${stderr.trim().slice(0, 300) || `exit ${code}`}`);
  const info = JSON.parse(stdout || "{}");
  const streams = info.streams || [];
  const v = streams.find(s => s.codec_type === "video");
  const a = streams.find(s => s.codec_type === "audio");
  return {
    durationSeconds: Number(info.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0,
    sizeBytes: Number(info.format?.size) || 0,
    formatName: info.format?.format_name || "",
    hasVideo: !!v,
    hasAudio: !!a,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels } : null,
  };
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(filePath).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}
