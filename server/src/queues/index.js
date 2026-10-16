// Queue backends. One queue per pipeline stage, each with its own concurrency, retry policy and timeout.
//   bullmq — production (Redis). Durable, survives restarts, stalled-job recovery.
//   memory — tests / local development only. Same semantics (job-id dedupe, retries, backoff), not durable.
import { STAGES } from "@reelscript/shared";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withTimeout } from "../utils/errors.js";

export const STAGE_POLICY = {
  [STAGES.DOWNLOAD]: { attempts: 3, backoffMs: 15_000 },
  [STAGES.AUDIO]: { attempts: 2, backoffMs: 5_000 },
  [STAGES.TRANSCRIBE]: { attempts: 4, backoffMs: 20_000 },
  [STAGES.ANALYZE]: { attempts: 3, backoffMs: 30_000 },
  [STAGES.MATCH]: { attempts: 2, backoffMs: 5_000 },
  [STAGES.GENERATE]: { attempts: 2, backoffMs: 30_000 },
  [STAGES.SCRIPT]: { attempts: 2, backoffMs: 30_000 },
};

export const jobIdFor = (stage, videoId) => `${stage}__${videoId}`;

// ---------------- memory backend ----------------
class MemoryQueues {
  constructor({ backoffScale = 1 } = {}) {
    this.backoffScale = backoffScale;
    this.queues = new Map();   // stage -> { waiting: [], active: Set, handler, concurrency }
    this.ids = new Set();      // waiting + active job ids (dedupe)
    this.timers = new Set();
    this.idleWaiters = [];
    this.closed = false;
  }
  q(stage) {
    if (!this.queues.has(stage)) this.queues.set(stage, { waiting: [], active: new Set(), handler: null, concurrency: 1 });
    return this.queues.get(stage);
  }
  async add(stage, data, { jobId } = {}) {
    if (jobId && this.ids.has(jobId)) return { id: jobId, duplicate: true };
    const job = { id: jobId || `${stage}-${Math.random().toString(36).slice(2)}`, stage, data, attemptsMade: 0 };
    this.ids.add(job.id);
    this.q(stage).waiting.push(job);
    queueMicrotask(() => this.pump(stage));
    return { id: job.id, duplicate: false };
  }
  register(stage, handler, { concurrency = 1 } = {}) {
    const q = this.q(stage);
    q.handler = handler; q.concurrency = concurrency;
    this.pump(stage);
  }
  pump(stage) {
    const q = this.q(stage);
    if (!q.handler || this.closed) return;
    while (q.active.size < q.concurrency && q.waiting.length) {
      const job = q.waiting.shift();
      q.active.add(job);
      this.run(q, job);
    }
    this.checkIdle();
  }
  async run(q, job) {
    const policy = STAGE_POLICY[job.stage] || { attempts: 1, backoffMs: 1000 };
    try {
      job.attemptsMade++;
      await withTimeout(Promise.resolve(q.handler(job)), config.timeouts[job.stage] || 600_000, `${job.stage} job`);
      q.active.delete(job); this.ids.delete(job.id);
    } catch (err) {
      q.active.delete(job);
      const retry = !err?.permanent && job.attemptsMade < policy.attempts && !this.closed;
      if (retry) {
        const delay = policy.backoffMs * 2 ** (job.attemptsMade - 1) * this.backoffScale;
        const t = setTimeout(() => { this.timers.delete(t); q.waiting.push(job); this.pump(job.stage); }, delay);
        this.timers.add(t);
      } else {
        this.ids.delete(job.id);
        await q.handler.onFinalFailure?.(job, err);
      }
    } finally {
      this.pump(job.stage);
    }
  }
  async removeForVideo(videoId) {
    let removed = 0;
    for (const q of this.queues.values()) {
      const keep = q.waiting.filter(j => j.data.videoId !== videoId);
      removed += q.waiting.length - keep.length;
      for (const j of q.waiting) if (j.data.videoId === videoId) this.ids.delete(j.id);
      q.waiting = keep;
    }
    return removed;
  }
  busy() {
    return this.timers.size > 0 || [...this.queues.values()].some(q => q.waiting.length || q.active.size);
  }
  checkIdle() {
    if (!this.busy()) { const w = this.idleWaiters.splice(0); w.forEach(r => r()); }
  }
  /** Resolve when no jobs are waiting, running or scheduled for retry (tests). */
  drain() { return this.busy() ? new Promise(r => this.idleWaiters.push(r)) : Promise.resolve(); }
  async counts() {
    const out = {};
    for (const [stage, q] of this.queues) out[stage] = { waiting: q.waiting.length, active: q.active.size };
    return out;
  }
  async health() { return { driver: "memory", ok: true, durable: false }; }
  async close() { this.closed = true; for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}

// ---------------- BullMQ backend ----------------
class BullQueues {
  constructor({ redisUrl, prefix = "reelscript" }) {
    this.redisUrl = redisUrl; this.prefix = prefix;
    this.queues = new Map(); this.workers = [];
  }
  async init() {
    const bull = await import("bullmq");
    const { default: IORedis } = await import("ioredis");
    this.bull = bull;
    this.connection = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    for (const stage of Object.values(STAGES))
      this.queues.set(stage, new bull.Queue(`${this.prefix}-${stage}`, { connection: this.connection }));
    return this;
  }
  async add(stage, data, { jobId } = {}) {
    const policy = STAGE_POLICY[stage];
    const q = this.queues.get(stage);
    if (jobId) {
      const existing = await q.getJob(jobId);
      if (existing && ["waiting", "active", "delayed", "prioritized", "waiting-children"].includes(await existing.getState())) return { id: jobId, duplicate: true };
      if (existing) await existing.remove().catch(() => {}); // completed/failed copy → allow a fresh run (retry)
    }
    const job = await q.add(stage, data, {
      jobId,
      attempts: policy.attempts,
      backoff: { type: "exponential", delay: policy.backoffMs },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
    return { id: job.id, duplicate: false };
  }
  register(stage, handler, { concurrency = 1 } = {}) {
    const { Worker, UnrecoverableError } = this.bull;
    const w = new Worker(`${this.prefix}-${stage}`, async (job) => {
      try {
        return await withTimeout(Promise.resolve(handler(job)), config.timeouts[stage] || 600_000, `${stage} job`);
      } catch (err) {
        if (err?.permanent) throw new UnrecoverableError(`${err.code || "PERMANENT"}: ${err.message}`);
        throw err;
      }
    }, { connection: this.connection, concurrency, lockDuration: 120_000, stalledInterval: 60_000, maxStalledCount: 2 });
    w.on("failed", async (job, err) => {
      if (!job) return;
      const final = err?.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts || 1);
      if (final) await handler.onFinalFailure?.(job, err);
    });
    w.on("error", err => logger.error({ err, stage }, "worker error"));
    this.workers.push(w);
  }
  async removeForVideo(videoId) {
    let removed = 0;
    for (const stage of Object.values(STAGES)) {
      const job = await this.queues.get(stage).getJob(jobIdFor(stage, videoId));
      if (job && ["waiting", "delayed", "prioritized"].includes(await job.getState())) { await job.remove().catch(() => {}); removed++; }
    }
    return removed;
  }
  async counts() {
    const out = {};
    for (const [stage, q] of this.queues) out[stage] = await q.getJobCounts("waiting", "active", "delayed", "failed");
    return out;
  }
  async health() {
    try { return { driver: "bullmq", ok: (await this.connection.ping()) === "PONG", durable: true }; }
    catch (e) { return { driver: "bullmq", ok: false, error: e.message }; }
  }
  async close() {
    await Promise.all(this.workers.map(w => w.close()));
    await Promise.all([...this.queues.values()].map(q => q.close()));
    await this.connection?.quit().catch(() => {});
  }
}

let backend = null;

export async function initQueues(opts = {}) {
  if (backend) return backend;
  if (config.queueDriver === "memory") {
    if (config.env === "production") logger.warn("QUEUE_DRIVER=memory: jobs are not durable — use bullmq in production");
    backend = new MemoryQueues(opts);
  } else {
    if (!config.redisUrl) throw new Error("REDIS_URL is required for QUEUE_DRIVER=bullmq");
    backend = await new BullQueues({ redisUrl: config.redisUrl }).init();
  }
  return backend;
}

export function queues() {
  if (!backend) throw new Error("Queues not initialised");
  return backend;
}

export async function closeQueues() {
  if (backend) { await backend.close(); backend = null; }
}
