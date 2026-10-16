// Extracts speech-quality audio with FFmpeg (independently retryable stage).
import path from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { permanent, transient } from "../../utils/errors.js";
import { FFMPEG_PATH, probe, run, safeName } from "../video/media.js";

export class AudioExtractor {
  constructor({ outputDir, timeoutMs = 180_000, sampleRate = 16000, channels = 1, format = "flac" } = {}) {
    Object.assign(this, { outputDir, timeoutMs, sampleRate, channels, format });
  }

  /**
   * @returns {Promise<{ audioPath: string|null, hasAudio: boolean, durationSeconds: number, sizeBytes: number, elapsedMs: number }>}
   * Videos with no audio stream return hasAudio=false (not an error).
   */
  async extract(videoPath, { videoId, sampleRate = this.sampleRate, channels = this.channels } = {}) {
    if (!videoId) throw new Error("videoId is required");
    const started = Date.now();
    const info = await probe(videoPath);
    if (!info.hasAudio) return { audioPath: null, hasAudio: false, durationSeconds: 0, sizeBytes: 0, elapsedMs: Date.now() - started };

    await mkdir(this.outputDir, { recursive: true });
    // FLAC: lossless, compact, accepted by AssemblyAI. 16 kHz mono preserves speech while keeping uploads small.
    const audioPath = path.join(this.outputDir, `${safeName(videoId)}.${this.format}`);
    await rm(audioPath, { force: true });
    const codec = { flac: ["-c:a", "flac"], wav: ["-c:a", "pcm_s16le"], mp3: ["-c:a", "libmp3lame", "-b:a", "64k"] }[this.format];
    const { code, stderr } = await run(FFMPEG_PATH, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", videoPath, "-vn", "-map", "0:a:0", "-ac", String(channels), "-ar", String(sampleRate), ...codec, audioPath,
    ], { timeoutMs: this.timeoutMs });
    if (code !== 0) {
      await rm(audioPath, { force: true });
      if (/Invalid data|could not find codec|Error opening input|moov atom not found/i.test(stderr))
        throw permanent("AUDIO_DECODE_FAILED", `FFmpeg could not decode the audio: ${stderr.trim().slice(0, 300)}`);
      throw transient("AUDIO_EXTRACTION_FAILED", `FFmpeg failed (exit ${code}): ${stderr.trim().slice(0, 300)}`);
    }

    // Validate the output: must exist, be non-trivial and decodable.
    const { size } = await stat(audioPath).catch(() => ({ size: 0 }));
    if (size < 1024) { await rm(audioPath, { force: true }); throw permanent("AUDIO_EMPTY", "Extracted audio is empty"); }
    const out = await probe(audioPath);
    if (!out.hasAudio || out.durationSeconds <= 0) { await rm(audioPath, { force: true }); throw permanent("AUDIO_INVALID", "Extracted audio is not readable"); }
    return { audioPath, hasAudio: true, durationSeconds: out.durationSeconds, sizeBytes: size, elapsedMs: Date.now() - started };
  }
}
