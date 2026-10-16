// Sequelize migrations via Umzug (Sequelize's migration engine).
//   node src/migrations/migrate.js up | down | status
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";
import { Umzug, SequelizeStorage } from "umzug";
import { initDatabase, closeDatabase, openSequelize } from "../models/index.js";
import { config } from "../config/env.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

export function createMigrator(sequelize) {
  const files = readdirSync(dir).filter(f => /^\d+-.+\.js$/.test(f)).sort();
  return new Umzug({
    migrations: files.map(name => ({
      name,
      up: async (params) => (await import(pathToFileURL(path.join(dir, name)).href)).up(params),
      down: async (params) => (await import(pathToFileURL(path.join(dir, name)).href)).down(params),
    })),
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, tableName: "schema_migrations" }),
    logger: undefined,
  });
}

export async function migrateUp(sequelize) {
  return createMigrator(sequelize).up();
}

/**
 * Apply pending migrations. With DATABASE_URL_UNPOOLED set (Neon), DDL runs over the direct connection
 * instead of the pooler, as Neon recommends; otherwise over the app's own connection.
 */
export async function migrateWithConfig(sequelize) {
  if (!config.databaseUrlUnpooled) return migrateUp(sequelize);
  const direct = await openSequelize(config.databaseUrlUnpooled, { ssl: config.dbSsl, pool: { max: 1 } });
  try { return await migrateUp(direct); } finally { await direct.close(); }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const cmd = process.argv[2] || "up";
  const { sequelize } = await initDatabase(config.databaseUrlUnpooled || config.databaseUrl, { ssl: config.dbSsl });
  const m = createMigrator(sequelize);
  if (cmd === "up") console.log("Applied:", (await m.up()).map(x => x.name));
  else if (cmd === "down") console.log("Reverted:", (await m.down()).map(x => x.name));
  else console.log({ executed: (await m.executed()).map(x => x.name), pending: (await m.pending()).map(x => x.name) });
  await closeDatabase();
}
