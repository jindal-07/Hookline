import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    globalSetup: ["tests/setup/global-setup.js"],
    setupFiles: ["tests/setup/env.js"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false, // integration suites share one embedded Postgres instance
    pool: "forks",
  },
});
