// Validates and normalises video URLs, and guards outbound requests against SSRF.
import dns from "node:dns/promises";
import net from "node:net";

const TRACKING_PARAMS = /^(utm_|fbclid$|mibextid$|rdid$|sfnsn$|s$|ref$|refsrc$|__tn__$|__cft__|_rdr$|extid$|app$|locale$|paipv$|eav$|share_url$|sk$)/i;
const FB_HOST = /(^|\.)facebook\.com$/i;

export class UrlValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, msg) => { throw new UrlValidationError(code, msg); };

function hostAllowed(host, allowedHosts) {
  return allowedHosts.some(a => host === a || host.endsWith(`.${a.replace(/^www\./, "")}`));
}

/**
 * Parse + validate + normalise. Returns { normalizedUrl, externalId, kind, host }.
 * Throws UrlValidationError with a stable code for invalid input.
 */
export function normalizeVideoUrl(raw, { allowedHosts }) {
  let input = String(raw ?? "").trim();
  if (!input) fail("EMPTY", "URL is empty");
  if (input.length > 2048) fail("TOO_LONG", "URL is longer than 2048 characters");
  if (/^(www\.|m\.|web\.)?(facebook\.com|fb\.watch)\//i.test(input)) input = `https://${input}`;

  let u;
  try { u = new URL(input); } catch { fail("MALFORMED", "Not a valid URL"); }
  if (!/^https?:$/.test(u.protocol)) fail("SCHEME", `Unsupported scheme "${u.protocol.replace(":", "")}" — use https`);
  if (u.username || u.password) fail("CREDENTIALS", "URLs containing credentials are not allowed");
  if (u.port && u.port !== "443" && u.port !== "80") fail("PORT", "Non-standard ports are not allowed");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) fail("IP_HOST", "IP-address URLs are not allowed");
  if (!hostAllowed(host, allowedHosts)) fail("HOST_NOT_ALLOWED", `Host "${host}" is not in the allowed video hosts`);

  // fb.watch short links: keep as https canonical form (resolved at download time with redirect validation)
  if (host === "fb.watch") {
    const code = u.pathname.split("/").filter(Boolean)[0];
    if (!code || !/^[\w-]+$/.test(code)) fail("UNSUPPORTED_FORMAT", "fb.watch link has no video code");
    return { normalizedUrl: `https://fb.watch/${code}/`, externalId: null, kind: "short", host };
  }

  if (FB_HOST.test(host)) return normalizeFacebook(u);

  // Other allow-listed hosts: generic normalisation
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.protocol = "https:"; u.hash = ""; u.port = "";
  return { normalizedUrl: u.toString().replace(/\/$/, ""), externalId: null, kind: "generic", host };
}

function normalizeFacebook(u) {
  const parts = u.pathname.split("/").filter(Boolean);
  const base = "https://www.facebook.com";
  const v = u.searchParams.get("v");
  const numeric = s => /^\d{5,25}$/.test(s || "");

  // /watch?v=ID, /watch/?v=ID, /video.php?v=ID, /watch/live/?v=ID
  if ((parts[0] === "watch" || parts[0] === "video.php") && numeric(v))
    return { normalizedUrl: `${base}/watch/?v=${v}`, externalId: v, kind: "watch", host: "www.facebook.com" };
  // /reel/ID
  if (parts[0] === "reel" && numeric(parts[1]))
    return { normalizedUrl: `${base}/reel/${parts[1]}`, externalId: parts[1], kind: "reel", host: "www.facebook.com" };
  // /{page}/videos/{id}  or  /{page}/videos/{slug}/{id}
  const vi = parts.indexOf("videos");
  if (vi >= 1) {
    const id = parts.slice(vi + 1).reverse().find(numeric);
    if (id) return { normalizedUrl: `${base}/${parts[0]}/videos/${id}`, externalId: id, kind: "page_video", host: "www.facebook.com" };
  }
  // /share/v/{code}/, /share/r/{code}/  (short share links — resolved at download)
  if (parts[0] === "share" && ["v", "r"].includes(parts[1]) && /^[\w-]+$/.test(parts[2] || ""))
    return { normalizedUrl: `${base}/share/${parts[1]}/${parts[2]}/`, externalId: null, kind: "share", host: "www.facebook.com" };
  // /groups/{g}/permalink/{id}  or /{user}/posts/{id} are posts, not guaranteed videos
  fail("UNSUPPORTED_FORMAT", "Not a recognised Facebook video or Reel URL (expected /reel/, /watch?v=, /videos/, /share/v|r/ or fb.watch)");
}

// ---------- SSRF guard ----------

const PRIVATE_V4 = [
  ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
  ["100.64.0.0", 10], ["0.0.0.0", 8], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4ToInt = ip => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => (n & (~0 << (32 - bits)) >>> 0) === (v4ToInt(base) & (~0 << (32 - bits)) >>> 0));
  }
  const low = ip.toLowerCase();
  if (low.startsWith("::ffff:")) return isPrivateAddress(low.slice(7));
  return low === "::" || low === "::1" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80") || low.startsWith("ff");
}

/** Resolve the host and refuse private/internal addresses (DNS-rebinding-aware check before any fetch). */
export async function assertPublicHost(hostname, lookup = dns.lookup) {
  const addrs = await lookup(hostname, { all: true });
  if (!addrs.length) fail("DNS", `Could not resolve ${hostname}`);
  const bad = addrs.find(a => isPrivateAddress(a.address));
  if (bad) fail("PRIVATE_ADDRESS", `${hostname} resolves to a private address (${bad.address})`);
  return addrs;
}

/**
 * Follow redirects manually (max 5), validating every hop against the allowlist and public-IP check.
 * Used for short links (fb.watch, /share/) before handing the final URL to the downloader.
 */
export async function resolveRedirects(url, { allowedHosts, fetchImpl = fetch, lookup = dns.lookup, maxHops = 5, timeoutMs = 10_000 }) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const u = new URL(current);
    if (!hostAllowed(u.hostname.toLowerCase(), allowedHosts)) fail("REDIRECT_HOST", `Redirected to a disallowed host: ${u.hostname}`);
    if (u.protocol !== "https:") fail("REDIRECT_SCHEME", "Redirect to non-https URL");
    await assertPublicHost(u.hostname, lookup);
    const res = await fetchImpl(current, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return current;
      current = new URL(loc, current).toString();
      continue;
    }
    return current;
  }
  fail("TOO_MANY_REDIRECTS", "Too many redirects");
}
