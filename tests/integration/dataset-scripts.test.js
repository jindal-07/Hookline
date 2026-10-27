// Training dataset → dataset profile → standalone scripts, through the real API, pipeline and Postgres.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../../server/src/app.js";
import { setupPipeline, teardownPipeline } from "../setup/pipeline.js";
import { closeDatabase } from "../../server/src/models/index.js";
import { setProviders } from "../../server/src/services/registry.js";
import { MockVideoAnalyzer } from "../../server/src/services/screenplay/GeminiVideoAnalyzer.js";
import { ManualSkillAdapter } from "../../server/src/services/generation/skillAdapters.js";
import { makeWorkbook } from "../fixtures/spreadsheets.js";
import { baseScreenplay } from "../fixtures/matching.js";
import { distinctVideos } from "../fixtures/media.js";
import { recoverInFlight } from "../../server/src/services/pipeline/orchestrator.js";

let env, app;
const U = (n) => `https://www.facebook.com/reel/70000000000${String(n).padStart(2, "0")}`;

function analysisFor(genre, subgenre, extra = {}) {
  const a = baseScreenplay();
  a.metadata = { ...a.metadata, genre, subgenre };
  Object.assign(a, extra);
  return a;
}

beforeEach(async () => {
  env = await setupPipeline();
  // 6 best (family dramas) and 6 bad (office comedies)
  const fixtures = {};
  for (let i = 0; i < 6; i++) fixtures[U(i)] = analysisFor("Drama", "Family Drama");
  for (let i = 6; i < 12; i++) fixtures[U(i)] = analysisFor("Comedy", "Office Comedy", { story_structure: baseScreenplay().story_structure.map(e => (e.element === "resolution" ? { ...e, status: "absent" } : e)) });
  const files = await distinctVideos(12);
  for (let i = 0; i < 12; i++) env.providers.downloader.fixtures[U(i)] = files[i];
  setProviders({ ...env.providers, analyzer: new MockVideoAnalyzer({ fixtures, defaultFixture: baseScreenplay() }) });
  app = createApp();
});
afterEach(teardownPipeline);
afterAll(closeDatabase);

const datasetSheet = () => makeWorkbook([
  ["video_url", "performance", "views"],
  ...Array.from({ length: 12 }, (_, i) => [U(i), i < 6 ? "best" : "bad", i < 6 ? 500000 : 3000]),
]);

async function runTrainingBatch() {
  const up = await request(app).post("/api/batches").field("purpose", "dataset").attach("file", datasetSheet(), "training.xlsx").expect(201);
  expect(up.body.batch.purpose).toBe("dataset");
  expect(up.body.summary).toMatchObject({ valid: 12, best: 6, bad: 6 });
  await request(app).post(`/api/batches/${up.body.batch.id}/process`).expect(200);
  await env.drain();
  // no automatic build: the analysed sheet is reviewed first, then the dataset is built explicitly
  const dataset = (await request(app).post("/api/datasets").send({}).expect(201)).body;
  return { batch: up.body.batch, dataset };
}

describe("training dataset + standalone scripts", () => {
  it("shows the analysed sheet for review and builds only when asked, honouring unticked rows", async () => {
    const up = await request(app).post("/api/batches").field("purpose", "dataset").attach("file", datasetSheet(), "training.xlsx").expect(201);
    await request(app).post(`/api/batches/${up.body.batch.id}/process`).expect(200);
    await env.drain();
    await new Promise(r => setTimeout(r, 200));
    await request(app).get("/api/datasets/latest").expect(404); // not built automatically
    const prev = (await request(app).get(`/api/batches/${up.body.batch.id}/analysis`).expect(200)).body;
    expect(prev.summary).toMatchObject({ total: 12, analysed: 12, usable: 12, best: 6, bad: 6 });
    expect(prev.in_dataset).toBeNull();
    const first = prev.rows[0];
    expect(first).toMatchObject({ row: expect.any(Number), label: "best", analysed: true, genre: "Drama", subgenre: expect.any(String), scene_count: expect.any(Number) });
    expect(first.duration).toBeGreaterThan(0);
    const built = (await request(app).post("/api/datasets").send({ excludeVideoIds: [first.video_id] }).expect(201)).body;
    expect(built).toMatchObject({ video_count: 11, best_count: 5, bad_count: 6 });
    expect(built.excluded).toContainEqual(expect.objectContaining({ video_id: first.video_id, reason: "excluded during review" }));
    const after = (await request(app).get(`/api/batches/${up.body.batch.id}/analysis`).expect(200)).body;
    expect(after.in_dataset).toMatchObject({ id: built.id, included: true });
    // generation batches have no analysis preview
    const gen = await request(app).post("/api/batches").attach("file", datasetSheet(), "gen.xlsx");
    if (gen.status === 201) await request(app).get(`/api/batches/${gen.body.batch.id}/analysis`).expect(400);
  });

  it("counts a video in several sheets once: an analysed copy is used, and best wins a best/bad conflict", async () => {
    await runTrainingBatch(); // U(0)–U(5) best, U(6)–U(11) bad, all analysed
    // a newer sheet, not processed yet, repeats U(0) and relabels U(6) as best
    const second = makeWorkbook([["video_url", "performance"], [U(0), "best"], [U(6), "best"]]);
    await request(app).post("/api/batches").field("purpose", "dataset").attach("file", second, "again.xlsx").expect(201);
    const ds = (await request(app).post("/api/datasets").send({}).expect(201)).body;
    expect(ds).toMatchObject({ video_count: 12, best_count: 7, bad_count: 5 });
    expect(ds.excluded).toEqual([]); // the unanalysed repeats don't push out the analysed copies
    expect(ds.profile.merged).toMatchObject({ duplicate_rows: 2, videos_in_several_sheets: 2, label_conflicts: [{ url: U(6), counted_as: "best" }] });
    expect(ds.profile.notes.join(" ")).toMatch(/labelled best in one sheet and bad in another; they count as best/);
  });

  it("imports transcript + screenplay text from a CSV: analysed from text, never downloaded, then built into the dataset", async () => {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const screenplay = (i) => `**[00:00 - 00:40] EXT. STREET - DAY**\n\nRAVI\nWhere were you last night‚Äôs ${i}?\n\nMEERA\nAt the office ‚Äî again.\n\n**[00:40 - 01:${i < 6 ? "30" : "50"}] INT. HOME - NIGHT**\n\nRAVI\nThen who is this?`;
    const csv = ["﻿video_url,duration_sec,transcript,screenplay,Performance",
      ...Array.from({ length: 12 }, (_, i) => [U(i), i < 6 ? 90 : 170, q("Where were you last night. At the office again. Then who is this."), q(screenplay(i)), i < 6 ? "Best" : "Bad"].join(","))].join("\r\n");
    const up = await request(app).post("/api/batches").field("purpose", "dataset").attach("file", Buffer.from(csv, "utf8"), "Book 4(Sheet1).csv").expect(201);
    expect(up.body.summary).toMatchObject({ valid: 12, best: 6, bad: 6, imported: 12 });
    expect(up.body.rows[0]).toMatchObject({ screenplay_chars: expect.any(Number), duration_seconds: 90 });
    expect(up.body.rows[0].import).toBeUndefined(); // text stays server-side

    const downloads = env.providers.downloader.calls.length;
    await request(app).post(`/api/batches/${up.body.batch.id}/process`).expect(200);
    await env.drain();
    expect(env.providers.downloader.calls.length).toBe(downloads); // nothing downloaded

    const vids = (await request(app).get(`/api/batches/${up.body.batch.id}/videos`)).body.items;
    expect(vids.every(v => v.status === "COMPLETED" && v.generation_status === "DATASET")).toBe(true);
    const detail = (await request(app).get(`/api/videos/${vids[0].id}`)).body;
    expect(detail.transcript.provider_metadata.provider).toBe("import");
    expect(detail.analysis.model_metadata.source).toBe("screenplay_text"); // analysed from the text, not a video
    expect(detail.transcript.normalized_transcript.dialogue_segments.length + detail.transcript.normalized_transcript.narration_segments.length).toBe(3);

    const prev = (await request(app).get(`/api/batches/${up.body.batch.id}/analysis`)).body;
    expect(prev.summary).toMatchObject({ analysed: 12, usable: 12, best: 6, bad: 6 });
    expect(prev.rows.find(r => r.label === "best").duration).toBe(90); // the sheet's duration, not the model's

    const ds = (await request(app).post("/api/datasets").send({}).expect(201)).body;
    expect(ds).toMatchObject({ video_count: 12, best_count: 6, bad_count: 6 });
    expect(ds.profile.overview.duration_best.median).toBe(90);
    expect(ds.profile.overview.duration_bad.median).toBe(170);
  });

  it("analyses training videos without per-video scripts and builds the dataset", async () => {
    const { batch, dataset } = await runTrainingBatch();
    const vids = (await request(app).get(`/api/batches/${batch.id}/videos`)).body.items;
    expect(vids.every(v => v.status === "COMPLETED" && v.generation_status === "DATASET")).toBe(true);
    expect(vids.filter(v => v.performance_label === "best")).toHaveLength(6);
    expect(env.providers.skillAdapter.calls).toHaveLength(0); // no per-video generation
    expect(dataset).toMatchObject({ video_count: 12, best_count: 6, bad_count: 6 });
    const g = dataset.profile.genres;
    expect(g[0]).toMatchObject({ genre: "Drama", best: 6, bad: 0 });
    expect(g[1]).toMatchObject({ genre: "Comedy", best: 0, bad: 6 });
    expect(dataset.profile.patterns.winning.map(p => p.value)).toContain("Uplifting resolution");
  });

  it("rebuilds on demand and previews the playbook", async () => {
    const { dataset } = await runTrainingBatch();
    const rebuilt = await request(app).post("/api/datasets").send({ name: "Week 42" }).expect(201);
    expect(rebuilt.body.name).toBe("Week 42");
    const pb = await request(app).get(`/api/datasets/${dataset.id}/playbook?genre=Drama&subgenre=Family%20Drama`).expect(200);
    expect(pb.body.evidence).toMatchObject({ videos: 6, best: 6 });
    expect(pb.body.duration.target_seconds).toBeGreaterThan(0);
    await request(app).post("/api/datasets").send({ bogus: 1 }).expect(400);
  });

  it("creates standalone scripts in the Scripts tab using the skill, checked for originality against the dataset", async () => {
    await runTrainingBatch();
    const created = await request(app).post("/api/scripts").send({ genre: "Drama", subgenre: "Family Drama", premise: "A night-shift tailor finds a stranger's wedding invitation sewn into a jacket", count: 2 }).expect(201);
    expect(created.body.items).toHaveLength(2);
    await env.drain();
    const list = (await request(app).get("/api/scripts")).body.items;
    expect(list.every(s => s.status === "COMPLETED")).toBe(true);
    const s = (await request(app).get(`/api/scripts/${list[0].id}`)).body;
    expect(s.content).toMatch(/## Scene 1 - /);
    expect(s.title).toBe("The Stitch Nobody Saw");
    expect(s.brief).toMatchObject({ genre: "Drama", subgenre: "Family Drama", language: "hi" });
    expect(s.originality.passed).toBe(true);
    expect(s.generation_metadata.format).toMatchObject({ scene_count: expect.any(Number), beat_candidates: 9 });
    const call = env.providers.skillAdapter.calls.at(-1);
    expect(call.payload.playbook.use_patterns.length).toBeGreaterThan(0);
    expect(call.ctx.requirements).toMatch(/STANDALONE/);
    const docx = await request(app).get(`/api/scripts/${s.id}/download`).expect(200); // Word by default
    expect(docx.headers["content-type"]).toMatch(/wordprocessingml/);
    expect(docx.headers["content-disposition"]).toMatch(/\.docx"/);
    const pdf = await request(app).get(`/api/scripts/${s.id}/download?format=pdf`).expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const md = await request(app).get(`/api/scripts/${s.id}/download?format=md`).expect(200);
    expect(md.headers["content-type"]).toMatch(/markdown/);
    await request(app).get(`/api/scripts/${s.id}/download?format=txt`).expect(400);
  });

  it("requeues a script whose job was lost in a restart (left RUNNING with nothing behind it)", async () => {
    const { dataset } = await runTrainingBatch();
    const stuck = await env.ctx.models.Script.create({ dataset_id: dataset.id, brief: { genre: "Drama", subgenre: "Family Drama", target_duration_seconds: 60, language: "hi" }, status: "RUNNING" });
    expect(await recoverInFlight()).toBeGreaterThanOrEqual(1); // requeued (the memory queue picks it up right away)
    await env.drain();
    expect((await stuck.reload()).status).toBe("COMPLETED");
  });

  it("rejects briefs for genres the dataset doesn't contain, and requires a dataset", async () => {
    await request(app).post("/api/scripts").send({ genre: "Drama" }).expect(400); // no dataset yet
    await runTrainingBatch();
    await request(app).post("/api/scripts").send({ genre: "Space Opera" }).expect(400);
    await request(app).post("/api/scripts").send({ genre: "Drama", count: 9 }).expect(400);
  });

  it("manual skill mode: exports a job, then an imported script is validated", async () => {
    await runTrainingBatch();
    setProviders({ ...env.providers, skillAdapter: new ManualSkillAdapter({ exchangeDir: "tests/.tmp/exchange", skillName: "scriptwriter-skill" }) });
    const { body } = await request(app).post("/api/scripts").send({ genre: "Drama" }).expect(201);
    await env.drain();
    const id = body.items[0].id;
    expect((await request(app).get(`/api/scripts/${id}`)).body.status).toBe("AWAITING_MANUAL");
    const copied = "# Episode 01: Copy\n\n## Scene 1 - INT. Kitchen - Day\n\nअब नौकरानी अफसर बनेगी यह सपना देखो कोशिश करने में क्या बुराई है मैडम. " + "Meera cooks. ".repeat(20);
    const imp = await request(app).post(`/api/scripts/${id}/import`).send({ content: copied }).expect(200);
    expect(imp.body.status).toBe("REJECTED");
    // The reused name is renamed automatically; the copied dialogue still rejects it.
    expect(imp.body.originality.issues.map(i => i.code)).toEqual(["HIGH_OVERLAP"]);
    expect(imp.body.generation_metadata.renamed).toEqual([expect.objectContaining({ from: "Meera" })]);
    expect(imp.body.content).not.toMatch(/Meera/);
  });
});
