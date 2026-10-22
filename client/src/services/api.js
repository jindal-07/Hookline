// Thin API client. All scoring/threshold decisions happen on the server — the client only displays them.
const token = () => { try { return localStorage.getItem("apiToken") || ""; } catch { return ""; } };

/** Fired when the server rejects a request (no or expired session), so the app can show the sign-in screen. */
export const AUTH_REQUIRED_EVENT = "hookline:auth-required";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

async function request(path, { method = "GET", body, form } = {}) {
  const headers = {};
  if (token()) headers.Authorization = `Bearer ${token()}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const qs = (params = {}) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return p.length ? `?${new URLSearchParams(p)}` : "";
};

export const api = {
  authSession: () => request("/auth/session"),
  login: (password) => request("/auth/login", { method: "POST", body: { password } }),
  logout: () => request("/auth/logout", { method: "POST" }),
  stats: () => request("/stats"),
  health: () => request("/health"),
  settings: () => request("/settings"),
  usage: (period = "30d") => request(`/usage${qs({ period })}`),
  saveUsageSettings: (body) => request("/usage/settings", { method: "PATCH", body }),
  saveSettings: (scoring) => request("/settings", { method: "PATCH", body: scoring }),

  uploadBatch: (file, purpose = "generation") => { const f = new FormData(); f.append("purpose", purpose); f.append("file", file); return request("/batches", { method: "POST", form: f }); },
  batches: () => request("/batches"),
  batch: (id) => request(`/batches/${id}`),
  processBatch: (id) => request(`/batches/${id}/process`, { method: "POST" }),
  cancelBatch: (id) => request(`/batches/${id}/cancel`, { method: "POST" }),
  batchVideos: (id, filters) => request(`/batches/${id}/videos${qs(filters)}`),
  batchAnalysis: (id) => request(`/batches/${id}/analysis`),

  videos: (filters) => request(`/videos${qs(filters)}`),
  video: (id) => request(`/videos/${id}`),
  retry: (id) => request(`/videos/${id}/retry`, { method: "POST" }),
  regenerate: (id) => request(`/videos/${id}/regenerate`, { method: "POST" }),
  importScript: (id, content) => request(`/videos/${id}/script`, { method: "POST", body: { content } }),

  datasets: () => request("/datasets"),
  latestDataset: () => request("/datasets/latest"),
  dataset: (id) => request(`/datasets/${id}`),
  buildDataset: (body = {}) => request("/datasets", { method: "POST", body }),
  playbook: (id, genre, subgenre) => request(`/datasets/${id}/playbook${qs({ genre, subgenre })}`),

  scripts: () => request("/scripts"),
  script: (id) => request(`/scripts/${id}`),
  createScripts: (body) => request("/scripts", { method: "POST", body }),
  regenerateStandalone: (id) => request(`/scripts/${id}/regenerate`, { method: "POST" }),
  importStandalone: (id, content) => request(`/scripts/${id}/import`, { method: "POST", body: { content } }),
  deleteScript: (id) => request(`/scripts/${id}`, { method: "DELETE" }),
};

/** URLs for file downloads (served with Content-Disposition by the API). */
export const downloads = {
  batchExport: (id, { format = "csv", scope = "all", ids, detailed } = {}) => `/api/batches/${id}/export${qs({ format, scope, ids: ids?.join(","), detailed: detailed ? "true" : undefined })}`,
  selectedExport: (ids, { format = "csv", detailed } = {}) => `/api/videos/export${qs({ format, ids: ids.join(","), detailed: detailed ? "true" : undefined })}`,
  validationReport: (id) => `/api/batches/${id}/validation-report`,
  videoJson: (id) => `/api/videos/${id}/export`,
  scriptFile: (id, format = "docx") => `/api/scripts/${id}/download?format=${format}`,
};

/** Download through fetch so the auth header is sent, then save via a blob link. */
export async function downloadFile(url) {
  const res = await fetch(url, { headers: token() ? { Authorization: `Bearer ${token()}` } : {} });
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  const name = res.headers.get("Content-Disposition")?.match(/filename="?([^"]+)"?/)?.[1] || "export";
  const blob = await res.blob();
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function eventsUrl(batchId) {
  return `/api/events${qs({ batchId, token: token() || undefined })}`;
}
