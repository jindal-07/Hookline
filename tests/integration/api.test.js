import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import http from "node:http";
import request from "supertest";
import * as XLSX from "xlsx";
import { createApp } from "../../server/src/app.js";
import { setupPipeline, teardownPipeline, URLS } from "../setup/pipeline.js";
import { closeDatabase } from "../../server/src/models/index.js";
import { makeWorkbook } from "../fixtures/spreadsheets.js";
import { publish } from "../../server/src/events/bus.js";

let env, app;
beforeEach(async () => { env = await setupPipeline(); app = createApp(); });
afterEach(teardownPipeline);
afterAll(closeDatabase);

const sheet = () => makeWorkbook([
  ["video_url", "title", "category", "views"],
  [URLS.good, "Maid's dream", "Drama", "250000"],
  [URLS.good2, "=HYPERLINK(\"http://evil\")", "Comedy", "1000"],
  [URLS.private, "Private one", "Drama", ""],
  [URLS.good + "?mibextid=dup", "Duplicate", "Drama", ""],
  ["https://example.com/x", "Bad host", "", ""],
]);

async function uploadAndRun() {
  const up = await request(app).post("/api/batches").attach("file", sheet(), "viral.xlsx").expect(201);
  await request(app).post(`/api/batches/${up.body.batch.id}/process`).expect(200);
  await env.drain();
  return up.body;
}

describe("REST API", () => {
  it("uploads, validates and previews a spreadsheet without starting processing", async () => {
    const r = await request(app).post("/api/batches").attach("file", sheet(), "viral.xlsx").expect(201);
    expect(r.body.summary).toEqual({ total_rows: 5, valid: 3, invalid: 2, duplicates: 1 });
    expect(r.body.batch.status).toBe("DRAFT");
    expect(r.body.rows.find(x => x.row === 5).errors[0].code).toBe("DUPLICATE");
    const list = await request(app).get(`/api/batches/${r.body.batch.id}/videos`).expect(200);
    expect(list.body.items.map(v => v.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    const report = await request(app).get(`/api/batches/${r.body.batch.id}/validation-report`).expect(200);
    expect(report.text).toContain("HOST_NOT_ALLOWED");
  });

  it("rejects unsupported uploads", async () => {
    await request(app).post("/api/batches").attach("file", Buffer.from("a,b"), "x.csv").expect(400);
    const noUrl = await request(app).post("/api/batches").attach("file", makeWorkbook([["link"], ["x"]]), "x.xlsx").expect(400);
    expect(noUrl.body.error.message).toMatch(/video_url/);
    await request(app).post("/api/batches").expect(400);
  });

  it("processes a batch and exposes results, filters, details and stats", async () => {
    const { batch } = await uploadAndRun();
    const b = await request(app).get(`/api/batches/${batch.id}`).expect(200);
    expect(b.body.batch).toMatchObject({ status: "COMPLETED", completed_videos: 2, failed_videos: 1 });
    expect(b.body.validation.invalid_rows).toHaveLength(2);
    expect(b.body.stats).toMatchObject({ total: 3, completed: 2, failed: 1, scripts_generated: 2, eligible: 2 });

    const above = await request(app).get(`/api/batches/${batch.id}/videos?threshold=above`).expect(200);
    expect(above.body.items).toHaveLength(2);
    const failed = await request(app).get(`/api/videos?status=FAILED`).expect(200);
    expect(failed.body.items).toHaveLength(1);
    expect(failed.body.items[0].error_code).toBe("VIDEO_PRIVATE");
    const drama = await request(app).get(`/api/videos?category=Drama&minScore=70`).expect(200);
    expect(drama.body.items).toHaveLength(1);
    await request(app).get(`/api/videos?status=BOGUS`).expect(400);

    const id = above.body.items[0].id;
    const d = await request(app).get(`/api/videos/${id}`).expect(200);
    expect(d.body.video.video_path).toBeUndefined(); // media paths never exposed
    expect(d.body.match.match_status).toBe("MATCHED");
    expect(d.body.logs.map(l => l.stage)).toEqual(expect.arrayContaining(["download", "audio", "transcribe", "analyze", "match", "generate"]));
    for (const p of ["transcript", "screenplay", "match", "story-dna", "script"]) await request(app).get(`/api/videos/${id}/${p}`).expect(200);
    await request(app).get(`/api/videos/not-a-uuid`).expect(400);
    await request(app).get(`/api/videos/00000000-0000-4000-8000-000000000000`).expect(404);

    const stats = await request(app).get("/api/stats").expect(200);
    expect(stats.body.avg_score).toBeGreaterThan(75);
    expect(stats.body.score_distribution).toHaveLength(10);
  });

  it("exports CSV, Excel and JSON (summary + detailed), with formula-injection protection", async () => {
    const { batch } = await uploadAndRun();
    const csv = await request(app).get(`/api/batches/${batch.id}/export?format=csv`).expect(200);
    const lines = csv.text.trim().split("\r\n"); // trim() also strips the UTF-8 BOM
    expect(lines[0]).toBe("video_url,title,category,views,likes,shares,status,story_score,character_score,dialogue_score,overall_score,confidence,match_status,generation_status,generated_script,error_message");
    expect(lines).toHaveLength(4);
    expect(csv.text).toContain(`"'=HYPERLINK`);

    const q = await request(app).get(`/api/batches/${batch.id}/export?format=xlsx&scope=qualifying`).buffer(true).parse((res, cb) => { const c = []; res.on("data", d => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); }).expect(200);
    const rows = XLSX.utils.sheet_to_json(XLSX.read(q.body).Sheets.Videos);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.match_status === "MATCHED")).toBe(true);

    const json = await request(app).get(`/api/batches/${batch.id}/export?format=json&detailed=true&scope=qualifying`).expect(200);
    expect(json.body.videos[0]).toHaveProperty("transcript.normalized.dialogue_segments");
    expect(json.body.videos[0]).toHaveProperty("story_dna.hook_pattern");
    expect(json.body.videos[0].match.evidence).toHaveProperty("story_matches");

    const ids = json.body.videos.map(v => v.video.id).join(",");
    const sel = await request(app).get(`/api/videos/export?format=json&ids=${ids}`).expect(200);
    expect(sel.body.count).toBe(2);
  });

  it("validates settings on the backend and applies the new threshold", async () => {
    const s = await request(app).get("/api/settings").expect(200);
    expect(s.body.scoring).toMatchObject({ matchThreshold: 75, storyWeight: 40, characterWeight: 30, dialogueWeight: 30 });
    expect(s.body.providers.skill.mode).toBe("mock");
    await request(app).patch("/api/settings").send({ storyWeight: 50 }).expect(400);
    await request(app).patch("/api/settings").send({ matchThreshold: 150 }).expect(400);
    await request(app).patch("/api/settings").send({ overall_score: 100 }).expect(400); // unknown keys rejected
    const ok = await request(app).patch("/api/settings").send({ matchThreshold: 99.5, storyWeight: 50, characterWeight: 25, dialogueWeight: 25 }).expect(200);
    expect(ok.body.scoring.matchThreshold).toBe(99.5);

    const { batch } = await uploadAndRun();
    const list = await request(app).get(`/api/batches/${batch.id}/videos`).expect(200);
    const scored = list.body.items.filter(v => v.match);
    expect(scored.every(v => v.status === "SKIPPED_LOW_SCORE")).toBe(true);
    const m = await request(app).get(`/api/videos/${scored[0].id}/match`).expect(200);
    expect(m.body.scoring_configuration).toMatchObject({ threshold: 99.5, weights: { story: 50, character: 25, dialogue: 25 } });
  });

  it("retries failed videos, refuses invalid retries, regenerates and imports scripts", async () => {
    const { batch } = await uploadAndRun();
    const list = (await request(app).get(`/api/batches/${batch.id}/videos`)).body.items;
    const failed = list.find(v => v.status === "FAILED");
    const done = list.find(v => v.status === "COMPLETED");
    await request(app).post(`/api/videos/${done.id}/retry`).expect(409);
    const r = await request(app).post(`/api/videos/${failed.id}/retry`).expect(200);
    expect(r.body.stages).toEqual(["download"]);
    await env.drain();
    await request(app).post(`/api/videos/${done.id}/regenerate`).expect(200);
    await env.drain();
    const imp = await request(app).post(`/api/videos/${done.id}/script`).send({ content: "INT. A NEW PLACE - DAY\n" + "An entirely new story about a lighthouse keeper who restores old radios. ".repeat(5) }).expect(201);
    expect(imp.body.generation_status).toBe("COMPLETED");
    await request(app).post(`/api/videos/${failed.id}/script`).send({ content: "x" }).expect(409);
  });

  it("cancels a batch", async () => {
    const up = await request(app).post("/api/batches").attach("file", sheet(), "viral.xlsx").expect(201);
    const r = await request(app).post(`/api/batches/${up.body.batch.id}/cancel`).expect(200);
    expect(r.body.cancelled).toBe(3);
    await request(app).post(`/api/batches/${up.body.batch.id}/process`).expect(409);
  });

  it("reports health of database, queue and media tools", async () => {
    const h = await request(app).get("/api/health").expect(200);
    expect(h.body.checks).toMatchObject({ database: { ok: true }, queue: { ok: true, driver: "memory" }, ffmpeg: { ok: true }, ffprobe: { ok: true } });
  });

  it("streams progress over Server-Sent Events", async () => {
    const server = app.listen(0);
    const { port } = server.address();
    const received = await new Promise((resolve, reject) => {
      const req = http.get({ port, path: "/api/events?batchId=b1" }, (res) => {
        let buf = "";
        res.on("data", (d) => {
          buf += d;
          if (buf.includes("event: video")) { req.destroy(); resolve(buf); }
        });
        setTimeout(() => {
          publish({ type: "video", batch_id: "other", video_id: "x", status: "PENDING" }); // filtered out
          publish({ type: "video", batch_id: "b1", video_id: "v1", status: "MATCHING" });
        }, 50);
      });
      req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
    });
    server.close();
    expect(received).toContain('"video_id":"v1"');
    expect(received).not.toContain('"video_id":"x"');
  });

  it("requires a bearer token when API_AUTH_TOKEN is set", async () => {
    process.env.API_AUTH_TOKEN = "s3cret-token";
    try {
      await request(app).get("/api/stats").expect(401);
      await request(app).get("/api/stats").set("Authorization", "Bearer s3cret-token").expect(200);
      await request(app).get("/api/health").expect(200); // health stays open for probes
    } finally {
      delete process.env.API_AUTH_TOKEN;
    }
  });
});
