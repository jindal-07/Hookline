// Password wall: one shared password (APP_PASSWORD) → a signed, HttpOnly session cookie.
// The signing key is derived from the password (or SESSION_SECRET), so sessions survive restarts and
// changing the password signs everyone out. No server-side session store is needed.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "hookline_session";
const MAX_AGE_SECONDS = 30 * 24 * 3600;

export const passwordRequired = () => !!process.env.APP_PASSWORD;

const key = () => createHash("sha256").update(`hookline-session:${process.env.SESSION_SECRET || ""}:${process.env.APP_PASSWORD || ""}`).digest();
const sign = (payload) => createHmac("sha256", key()).update(payload).digest("base64url");

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Compares hashes so the comparison is constant-time regardless of the guess's length. */
export function checkPassword(given) {
  const expected = process.env.APP_PASSWORD || "";
  if (!expected) return false;
  const h = (s) => createHash("sha256").update(String(s ?? "")).digest();
  return timingSafeEqual(h(given), h(expected));
}

export function createSessionValue(now = Date.now()) {
  const exp = String(Math.floor(now / 1000) + MAX_AGE_SECONDS);
  return `${exp}.${sign(exp)}`;
}

export function isValidSession(value, now = Date.now()) {
  if (!value || typeof value !== "string") return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 < now) return false;
  return safeEqual(sig, sign(exp));
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(value, { secure, clear = false } = {}) {
  const attrs = [`${SESSION_COOKIE}=${clear ? "" : encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${clear ? 0 : MAX_AGE_SECONDS}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export const hasValidSession = (req) => isValidSession(readCookie(req, SESSION_COOKIE));
