import { describe, it, expect, afterEach } from "vitest";
import { checkConfig, config } from "../../server/src/config/env.js";

describe("production safety checks", () => {
  const saved = { token: process.env.API_AUTH_TOKEN, allow: process.env.ALLOW_PUBLIC_API };
  afterEach(() => {
    for (const [k, v] of [["API_AUTH_TOKEN", saved.token], ["ALLOW_PUBLIC_API", saved.allow]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  const prod = { ...config, env: "production", databaseUrl: "postgres://x", queueDriver: "memory" };

  it("refuses to start in production without an API token", () => {
    delete process.env.API_AUTH_TOKEN;
    expect(checkConfig(prod).errors.join(" ")).toMatch(/API_AUTH_TOKEN is required in production/);
  });

  it("starts with a token, or when explicitly allowed behind other access control", () => {
    process.env.API_AUTH_TOKEN = "t0ken";
    expect(checkConfig(prod).errors.join(" ")).not.toMatch(/API_AUTH_TOKEN/);
    delete process.env.API_AUTH_TOKEN;
    process.env.ALLOW_PUBLIC_API = "true";
    expect(checkConfig(prod).errors.join(" ")).not.toMatch(/API_AUTH_TOKEN/);
  });

  it("does not require a token for local development", () => {
    delete process.env.API_AUTH_TOKEN;
    expect(checkConfig({ ...prod, env: "development" }).errors.join(" ")).not.toMatch(/API_AUTH_TOKEN/);
  });
});
