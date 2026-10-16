// Starts a throwaway real PostgreSQL (embedded-postgres) for the whole test run.
// Set TEST_DATABASE_URL to use an existing server instead.
import path from "node:path";
import { rmSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

const PORT = 54329;
const dir = path.resolve(".pg-test");

export async function setup() {
  if (process.env.TEST_DATABASE_URL) return;
  rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: PORT, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("reelscript_test");
  globalThis.__pg = pg;
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
