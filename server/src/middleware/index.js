import { timingSafeEqual } from "node:crypto";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { AppError, badRequest } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/env.js";
import { passwordRequired, hasValidSession } from "../services/auth/session.js";

/** Validate req[part] against a zod schema; replaces it with the parsed value. */
export const validateReq = (part, schema) => (req, _res, next) => {
  const r = schema.safeParse(req[part] ?? {});
  if (!r.success) return next(badRequest(`Invalid ${part}`, r.error.issues.map(i => `${i.path.join(".") || part}: ${i.message}`)));
  Object.defineProperty(req, part === "query" ? "validQuery" : part, { value: r.data, writable: true, configurable: true });
  next();
};

export const uuidParam = z.object({ id: z.string().uuid() });

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => (/\.(xlsx|xls|csv)$/i.test(file.originalname) ? cb(null, true) : cb(badRequest("Only .xlsx, .xls and .csv files are supported"))),
});

export const apiLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-7", legacyHeaders: false });
export const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Too many uploads — try again in a minute" } } });

/**
 * Access control. The web app signs in with APP_PASSWORD (session cookie, sent automatically with every
 * request including EventSource). API_AUTH_TOKEN optionally allows programmatic access with a bearer token
 * (EventSource can't send headers, so /api/events also accepts ?token=). With neither set, the API is open
 * (local development only — production refuses to start that way).
 */
/** True when no token is configured, or the request carries the right one (header, or ?token= for /events). */
export function isAuthorized(req) {
  const token = process.env.API_AUTH_TOKEN;
  if (!token && !passwordRequired()) return true;
  if (passwordRequired() && hasValidSession(req)) return true;
  if (!token) return false;
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || (req.path === "/events" ? String(req.query.token || "") : "");
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function auth(req, res, next) {
  if (req.path === "/health" || isAuthorized(req)) return next();
  res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid API token" } });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? `File is larger than ${Math.round(config.limits.maxUploadBytes / 1048576)} MB` : err.message;
    return res.status(400).json({ error: { code: "UPLOAD_REJECTED", message: msg } });
  }
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: { code: "BAD_JSON", message: "Request body is not valid JSON" } });
  const status = err instanceof AppError ? err.status : 500;
  if (status >= 500) logger.error({ err, path: req.path }, "request failed");
  res.status(status).json({
    error: {
      code: err.code || "INTERNAL",
      message: status >= 500 && config.env === "production" ? "Internal server error" : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}
