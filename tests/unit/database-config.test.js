import { describe, it, expect } from "vitest";
import { sslEnabled } from "../../server/src/models/index.js";

describe("database SSL detection", () => {
  const neon = "postgresql://app:pw@ep-cool-river-a1b2c3-pooler.ap-southeast-1.aws.neon.tech/hookline?sslmode=require&channel_binding=require";

  it("turns SSL on automatically for Neon and for sslmode=require URLs", () => {
    expect(sslEnabled(neon)).toBe(true);
    expect(sslEnabled("postgresql://app:pw@ep-x.us-east-2.aws.neon.tech/db")).toBe(true);
    expect(sslEnabled("postgres://u:p@db.example.com:5432/app?sslmode=verify-full")).toBe(true);
  });

  it("leaves SSL off for local databases", () => {
    expect(sslEnabled("postgres://reelscript:reelscript@localhost:5432/reelscript")).toBe(false);
    expect(sslEnabled("postgres://u:p@127.0.0.1:54329/test?sslmode=disable")).toBe(false);
  });

  it("lets an explicit DB_SSL setting win", () => {
    expect(sslEnabled(neon, false)).toBe(false);
    expect(sslEnabled("postgres://u:p@localhost/app", true)).toBe(true);
  });
});
