// Downloader abstraction + implementations. Providers are replaceable; none bypass
// authentication, DRM or platform access controls.
import path from "node:path";
import { mkdir, readdir, rm, stat, copyFile } from "node:fs/promises";
import youtubedl from "youtube-dl-exec";
import { permanent, transient, AppError } from "../../utils/errors.js";
import { FFMPEG_PATH, probe, safeName } from "./media.js";
import { resolveRedirects } from "../url/UrlValidator.js";

const ALLOWED_CONTAINERS = /mp4|mov|matroska|webm|3gp/;

export class VideoDownloader {
  /** @returns {Promise<{ filePath, sizeBytes, durationSeconds, metadata }>} */
  async download(url, options = {}) { throw new Error("not implemented"); }  // eslint-disable-line no-unused-vars
  /** @returns {Promise<object>} provider metadata without downloading */
  async getMetadata(url) { throw new Error("not implemented"); }            // eslint-disable-line no-unused-vars
  get name() { return "base"; }
}

/** Map yt-dlp stderr to stable error codes. Permanent errors are not retried. */
export function classifyYtDlpError(stderr = "") {
  const s = String(stderr);
  const rules = [
    [/private video|this video is private|content isn.t available.*(private|permission)|you must be logged in|login required|log in to (continue|view)/i, "VIDEO_PRIVATE", true, "The video is private or requires login."],
    [/video unavailable|this video is unavailable|has been removed|no longer available|does not exist|page isn.t available|content isn.t available right now|HTTP Error 404/i, "VIDEO_UNAVAILABLE", true, "The video is unavailable or was deleted."],
    [/unsupported url/i, "UNSUPPORTED_URL", true, "This URL is not supported by the downloader."],
    [/no video formats found|requested format is not available/i, "NO_FORMATS", true, "No downloadable video format was found."],
    [/not (made this video )?available in your country|geo.?restrict/i, "GEO_BLOCKED", true, "The video is not available in this region."],
    [/sign in to confirm you.?re not a bot|confirm your age|age.?restricted/i, "AUTH_REQUIRED", true, "The platform requires sign-in for this video."],
    [/drm/i, "DRM_PROTECTED", true, "The video is DRM-protected and cannot be downloaded."],
    [/HTTP Error 429|too many requests|rate.?limit|try again later/i, "RATE_LIMITED", false, "The platform is rate-limiting requests."],
    [/timed out|timeout|connection (reset|refused)|temporary failure|network is unreachable|HTTP Error 5\d\d/i, "NETWORK", false, "Network error while downloading."],
  ];
  for (const [re, code, isPermanent, msg] of rules)
    if (re.test(s)) return new AppError(code, `${msg} (${firstErrorLine(s)})`, { permanent: isPermanent });
  return transient("DOWNLOAD_FAILED", `Download failed: ${firstErrorLine(s) || "unknown error"}`);
}
const firstErrorLine = s => (String(s).split("\n").find(l => /ERROR/.test(l)) || String(s).split("\n")[0] || "").replace(/^ERROR:\s*/, "").trim().slice(0, 300);

export class YtDlpDownloader extends VideoDownloader {
  constructor({ outputDir, ytdlpPath, cookiesFile, allowedHosts, maxDurationSeconds, maxSizeBytes, timeoutMs = 300_000, fetchImpl, lookup } = {}) {
    super();
    Object.assign(this, { outputDir, cookiesFile, allowedHosts, maxDurationSeconds, maxSizeBytes, timeoutMs, fetchImpl, lookup });
    this.exec = ytdlpPath ? youtubedl.create(ytdlpPath) : youtubedl;
  }
  get name() { return "yt-dlp"; }

  baseFlags() {
    return {
      noPlaylist: true, noWarnings: true, noCallHome: undefined, noProgress: true,
      ...(this.cookiesFile ? { cookies: this.cookiesFile } : {}), // user-supplied cookies for videos they are authorised to access
    };
  }

  async resolve(url) {
    // Short links are resolved here with per-hop host + private-IP validation (SSRF guard).
    if (/fb\.watch\/|\/share\/[vr]\//.test(url))
      return resolveRedirects(url, { allowedHosts: this.allowedHosts, fetchImpl: this.fetchImpl, lookup: this.lookup });
    return url;
  }

  async getMetadata(url) {
    const target = await this.resolve(url);
    try {
      const info = await this.exec(target, { ...this.baseFlags(), dumpSingleJson: true, skipDownload: true }, { timeout: Math.min(this.timeoutMs, 90_000) });
      return {
        id: info.id, title: info.title, duration: info.duration ?? null, uploader: info.uploader ?? null,
        upload_date: info.upload_date ?? null, view_count: info.view_count ?? null, like_count: info.like_count ?? null,
        webpage_url: info.webpage_url ?? target, extractor: info.extractor_key ?? info.extractor,
        filesize_approx: info.filesize_approx ?? null,
      };
    } catch (e) {
      throw e instanceof AppError ? e : classifyYtDlpError(e.stderr || e.message);
    }
  }

  async download(url, { videoId, maxHeight = 720 } = {}) {
    if (!videoId) throw new Error("videoId is required");
    const meta = await this.getMetadata(url);
    if (this.maxDurationSeconds && meta.duration && meta.duration > this.maxDurationSeconds)
      throw permanent("VIDEO_TOO_LONG", `Video is ${Math.round(meta.duration)}s, above the ${this.maxDurationSeconds}s limit`);
    if (this.maxSizeBytes && meta.filesize_approx && meta.filesize_approx > this.maxSizeBytes * 1.2)
      throw permanent("VIDEO_TOO_LARGE", `Video is about ${Math.round(meta.filesize_approx / 1048576)} MB, above the ${Math.round(this.maxSizeBytes / 1048576)} MB limit`);

    const dir = path.join(this.outputDir, safeName(videoId));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const hasFfmpeg = !!FFMPEG_PATH;
    try {
      await this.exec(meta.webpage_url || url, {
        ...this.baseFlags(),
        format: hasFfmpeg ? `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b` : `b[height<=${maxHeight}][ext=mp4]/b`,
        ...(hasFfmpeg ? { mergeOutputFormat: "mp4", ffmpegLocation: FFMPEG_PATH } : {}),
        output: path.join(dir, `${safeName(videoId)}.%(ext)s`),
        ...(this.maxSizeBytes ? { maxFilesize: `${Math.round(this.maxSizeBytes / 1048576)}M` } : {}),
        restrictFilenames: true,
      }, { timeout: this.timeoutMs });
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      if (e.timedOut || /timed out/i.test(e.message)) throw transient("TIMEOUT", `Download timed out after ${Math.round(this.timeoutMs / 1000)}s`);
      throw classifyYtDlpError(e.stderr || e.message);
    }
    return finalizeDownload(dir, { maxSizeBytes: this.maxSizeBytes, maxDurationSeconds: this.maxDurationSeconds, metadata: { ...meta, provider: this.name } });
  }
}

/** Validate the downloaded file (type, size, duration) and return its details. */
export async function finalizeDownload(dir, { maxSizeBytes, maxDurationSeconds, metadata = {} }) {
  const files = (await readdir(dir)).filter(f => !/\.(part|ytdl|temp)$/.test(f));
  if (!files.length) throw transient("DOWNLOAD_EMPTY", "The downloader finished without producing a file");
  const filePath = path.join(dir, files[0]);
  const { size } = await stat(filePath);
  if (maxSizeBytes && size > maxSizeBytes) {
    await rm(dir, { recursive: true, force: true });
    throw permanent("VIDEO_TOO_LARGE", `Downloaded file is ${Math.round(size / 1048576)} MB, above the limit`);
  }
  const info = await probe(filePath);
  if (!info.hasVideo || !ALLOWED_CONTAINERS.test(info.formatName)) {
    await rm(dir, { recursive: true, force: true });
    throw permanent("UNSUPPORTED_FORMAT", `Downloaded file is not a supported video (${info.formatName || "unknown"})`);
  }
  if (maxDurationSeconds && info.durationSeconds > maxDurationSeconds) {
    await rm(dir, { recursive: true, force: true });
    throw permanent("VIDEO_TOO_LONG", `Video is ${Math.round(info.durationSeconds)}s, above the limit`);
  }
  return { filePath, sizeBytes: size, durationSeconds: info.durationSeconds, hasAudio: info.hasAudio, metadata: { ...metadata, probe: info } };
}

/**
 * Test/demo downloader: copies a local fixture video. Behaviour can be scripted per URL:
 *   fixtures: { [url]: "path/to/file.mp4" | { error: "VIDEO_PRIVATE" } }
 */
export class MockDownloader extends VideoDownloader {
  constructor({ outputDir, fixtures = {}, defaultFixture, maxSizeBytes, maxDurationSeconds } = {}) {
    super();
    Object.assign(this, { outputDir, fixtures, defaultFixture, maxSizeBytes, maxDurationSeconds });
    this.calls = [];
  }
  get name() { return "mock"; }
  async getMetadata(url) { return { id: url.match(/\d{5,}/)?.[0] ?? "mock", title: "Mock video", webpage_url: url, provider: this.name }; }
  async download(url, { videoId } = {}) {
    this.calls.push(url);
    const f = this.fixtures[url] ?? this.defaultFixture;
    if (!f) throw permanent("DOWNLOADER_NOT_CONFIGURED", "Mock downloader has no fixture for this URL");
    if (typeof f === "object" && f.error) throw new AppError(f.error, f.message || `Mock error ${f.error}`, { permanent: f.permanent ?? true });
    const dir = path.join(this.outputDir, safeName(videoId));
    await mkdir(dir, { recursive: true });
    await copyFile(f, path.join(dir, `${safeName(videoId)}${path.extname(f)}`));
    return finalizeDownload(dir, { maxSizeBytes: this.maxSizeBytes, maxDurationSeconds: this.maxDurationSeconds, metadata: await this.getMetadata(url) });
  }
}

/** Used when DOWNLOADER=none: reports the limitation honestly instead of pretending. */
export class UnavailableDownloader extends VideoDownloader {
  get name() { return "none"; }
  async getMetadata() { throw permanent("DOWNLOADER_NOT_CONFIGURED", "No video downloader is configured (DOWNLOADER=none)"); }
  async download() { throw permanent("DOWNLOADER_NOT_CONFIGURED", "No video downloader is configured (DOWNLOADER=none). Configure yt-dlp or provide videos another way."); }
}
