import { describe, it, expect, afterEach } from "vitest";
import { checkConfig, config } from "../../server/src/config/env.js";
import { checkPassword, createSessionValue, isValidSession, sessionCookie } from "../../server/src/services/auth/session.js";

const KEYS = ["APP_PASSWORD", "API_AUTH_TOKEN", "ALLOW_PUBLIC_API", "SESSION_SECRET"];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); });
const clear = () => { for (const k of KEYS) delete process.env[k]; };

describe("production safety checks", () => {
  const prod = { ...config, env: "production", databaseUrl: "postgres://x", queueDriver: "memory" };

  it("refuses to start in production without a password", () => {
    clear();
    expect(checkConfig(prod).errors.join(" ")).toMatch(/APP_PASSWORD is required in production/);
  });

  it("starts with a password (or an API token, or when explicitly allowed behind other access control)", () => {
    for (const [k, v] of [["APP_PASSWORD", "a-long-shared-passphrase"], ["API_AUTH_TOKEN", "t0ken"], ["ALLOW_PUBLIC_API", "true"]]) {
      clear(); process.env[k] = v;
      expect(checkConfig(prod).errors.join(" ")).not.toMatch(/APP_PASSWORD is required/);
    }
  });

  it("warns about short passwords and doesn't require one locally", () => {
    clear(); process.env.APP_PASSWORD = "short";
    expect(checkConfig(prod).warnings.join(" ")).toMatch(/shorter than 12/);
    clear();
    expect(checkConfig({ ...prod, env: "development" }).errors.join(" ")).not.toMatch(/APP_PASSWORD/);
  });
});

describe("password sessions", () => {
  it("checks the password exactly", () => {
    clear(); process.env.APP_PASSWORD = "correct horse battery";
    expect(checkPassword("correct horse battery")).toBe(true);
    expect(checkPassword("correct horse batter")).toBe(false);
    expect(checkPassword("")).toBe(false);
  });

  it("issues signed sessions that can't be forged, expire, and end when the password changes", () => {
    clear(); process.env.APP_PASSWORD = "correct horse battery";
    const v = createSessionValue();
    expect(isValidSession(v)).toBe(true);
    const [exp, sig] = v.split(".");
    expect(isValidSession(`${Number(exp) + 1000}.${sig}`)).toBe(false);          // extended expiry, old signature
    expect(isValidSession(`${exp}.${sig.slice(0, -2)}xx`)).toBe(false);           // tampered signature
    expect(isValidSession(v, (Number(exp) + 1) * 1000)).toBe(false);             // expired
    process.env.APP_PASSWORD = "a new password entirely";
    expect(isValidSession(v)).toBe(false);                                        // password changed → signed out
  });

  it("sets a hardened cookie", () => {
    const c = sessionCookie("abc", { secure: true });
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Secure/);
    expect(sessionCookie("", { clear: true })).toMatch(/Max-Age=0/);
  });
});
