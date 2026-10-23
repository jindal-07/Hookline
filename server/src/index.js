// API server entry point.  npm run dev -w server
import { config, checkConfig } from "./config/env.js";
import { initDatabase, closeDatabase } from "./models/index.js";
import { migrateWithConfig } from "./migrations/migrate.js";
import { initQueues, closeQueues } from "./queues/index.js";
import { initEventBridge, closeEventBridge } from "./events/bus.js";
import { createApp } from "./app.js";
import { logger } from "./utils/logger.js";

const { errors, warnings } = checkConfig(config);
for (const w of warnings) logger.warn(w);
if (errors.length) {
  for (const e of errors) logger.error(e);
  logger.error("Fix the configuration in .env (see .env.example) and restart.");
  process.exit(1);
}

const { sequelize } = await initDatabase(config.databaseUrl, { ssl: config.dbSsl });
if (process.env.AUTO_MIGRATE !== "false") {
  const applied = await migrateWithConfig(sequelize);
  if (applied.length) logger.info({ applied: applied.map(m => m.name) }, "migrations applied");
}
// Claim the port first. If another Hookline server already owns it, exit before starting any job workers:
// a second server would otherwise process the same jobs in the background (duplicate, paid provider calls).
const server = await new Promise((resolve) => {
  const s = createApp().listen(config.port, config.host);
  s.once("listening", () => resolve(s));
  s.once("error", (err) => {
    logger.error(err.code === "EADDRINUSE"
      ? `Port ${config.port} is already in use — another Hookline server is probably running. Stop it first (only one server may process jobs).`
      : `Could not start the API: ${err.message}`);
    process.exit(1);
  });
});
logger.info(`API listening on http://${config.host}:${config.port}`);

await initQueues();
await initEventBridge();
if (config.runWorkersInApi || config.queueDriver === "memory") {
  const { startWorkers } = await import("./workers/index.js");
  await startWorkers(); // single-process mode (memory driver always runs workers in-process)
}

const shutdown = async (sig) => {
  logger.info({ sig }, "shutting down");
  server.close();
  await closeQueues();
  await closeEventBridge();
  await closeDatabase();
  await globalThis.__reelscriptShutdownHook?.(); // e.g. demo's embedded Postgres
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
