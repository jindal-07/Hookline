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
await initQueues();
await initEventBridge();
if (config.runWorkersInApi || config.queueDriver === "memory") {
  const { startWorkers } = await import("./workers/index.js");
  await startWorkers(); // single-process mode (memory driver always runs workers in-process)
}

const server = createApp().listen(config.port, config.host, () => {
  logger.info(`API listening on http://${config.host}:${config.port}`);
});

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
