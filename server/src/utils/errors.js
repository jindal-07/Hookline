/**
 * Application error with a stable machine code.
 * `permanent` errors (invalid URL, private video, bad credentials, unsupported format) are never retried.
 */
export class AppError extends Error {
  constructor(code, message, { status = 500, permanent = false, details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.permanent = permanent;
    this.details = details;
  }
}

export const permanent = (code, message, opts = {}) => new AppError(code, message, { ...opts, permanent: true });
export const transient = (code, message, opts = {}) => new AppError(code, message, { ...opts, permanent: false });

export const badRequest = (message, details) => new AppError("BAD_REQUEST", message, { status: 400, permanent: true, details });
export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`, { status: 404, permanent: true });
export const conflict = (message) => new AppError("CONFLICT", message, { status: 409, permanent: true });

/** Best-effort classification of provider/HTTP errors into permanent vs transient. */
export function classifyError(err) {
  if (err instanceof AppError) return err;
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  const msg = String(err?.message || err);
  if (status === 401 || status === 403 || /api key|unauthori[sz]ed|permission denied|invalid credentials/i.test(msg))
    return permanent("PROVIDER_AUTH", msg, { cause: err });
  if (status === 400 || status === 404 || status === 422) return permanent("PROVIDER_REJECTED", msg, { cause: err });
  if (status === 429 || /rate limit|quota|resource_exhausted/i.test(msg)) return transient("PROVIDER_RATE_LIMIT", msg, { cause: err });
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|5\d\d/i.test(msg) || (status >= 500 && status < 600))
    return transient("PROVIDER_UNAVAILABLE", msg, { cause: err });
  return transient("UNEXPECTED", msg, { cause: err });
}

/** Rejects with a transient timeout error if `promise` doesn't settle within `ms`. */
export function withTimeout(promise, ms, label = "operation") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(transient("TIMEOUT", `${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
