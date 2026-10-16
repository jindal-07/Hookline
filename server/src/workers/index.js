// Worker process: one BullMQ worker per stage, with per-stage concurrency limits.
//   npm run worker -w server
import { pathToFileURL } from "node:url";
import { config, checkConfig } from "../config/env.js";
import { initDatabase, closeDatabase } from "../models/index.js";
import { initQueues, queues, closeQueues } from "../queues/index.js";
import { initEventBridge, closeEventBridge } from "../events/bus.js";
import { handlers, recoverInFlight, sweepMedia } from "../services/pipeline/orchestrator.js";
import { logger } from "../utils/logger.js";

let sweepTimer = null;

/** Register stage handlers on the current queue backend (used by the worker process, inline mode and tests). */
export async function startWorkers({ recover = true, sweepEveryMs = 15 * 60_000 } = {}) {
  const q = queues();
  for (const [stage, handler] of Object.entries(handlers))
    q.register(stage, handler, { concurrency: Math.max(1, config.concurrency[stage] || 1) });
  if (recover) await recoverInFlight();
  if (sweepEveryMs && !config.isTest) {
    sweepTimer = setInterval(() => sweepMedia().catch(err => logger.error({ err }, "media sweep failed")), sweepEveryMs);
    sweepTimer.unref?.();
  }
  logger.info({ driver: config.queueDriver, concurrency: config.concurrency }, "workers started");
}

export function stopWorkers() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const { errors, warnings } = checkConfig(config);
  for (const w of warnings) logger.warn(w);
  if (errors.length) { for (const e of errors) logger.error(e); process.exit(1); }
  await initDatabase(config.databaseUrl, { ssl: config.dbSsl });
  await initQueues();
  await initEventBridge();
  await startWorkers();
  const shutdown = async (sig) => {
    logger.info({ sig }, "shutting down workers");
    stopWorkers();
    await closeQueues(); // lets active jobs finish; stalled jobs are recovered by BullMQ on next start
    await closeEventBridge();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
