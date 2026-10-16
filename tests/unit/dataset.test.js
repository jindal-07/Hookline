import { describe, it, expect } from "vitest";
import { buildDatasetProfile, playbookFor, canonical, patternLift } from "../../server/src/services/dataset/DatasetBuilder.js";
import { parseSpreadsheet, parsePerformance } from "../../server/src/services/excel/ExcelParser.js";
import { makeWorkbook } from "../fixtures/spreadsheets.js";
import { baseScreenplay } from "../fixtures/matching.js";

// Synthetic analysed videos: best ones are short family dramas with a "Hidden secret" hook and uplifting endings;
// bad ones are long comedies with slow pacing and open endings.
function item(i, label, { genre, subgenre, duration, hook, pacing, ending, views }) {
  const analysis = baseScreenplay();
  analysis.metadata = { ...analysis.metadata, genre, subgenre, duration_seconds: duration };
  return {
    video: { id: `v${i}`, performance_label: label, views, media_metadata: { download: { duration_seconds: duration } } },
    analysis,
    transcript: { language: "hi", stats: { speech_ratio: 0.6 } },
    storyDna: { hook_pattern: hook, pacing, ending_type: ending, story_engine: ["Open with a hidden secret"], dialogue_functions: [label === "best" ? "Reveal a hidden truth" : "Convey key information"], emotional_arc: ["Curiosity", "Hope"], avoid: ['character name "Meera"'] },
    match: { confidence: 0.85 },
  };
}
const best = Array.from({ length: 10 }, (_, i) => item(i, "best", { genre: i < 8 ? "drama" : "Comedy", subgenre: i < 8 ? "family drama" : "Office Comedy", duration: 55 + i, hook: "Hidden secret", pacing: "Fast", ending: "Uplifting resolution", views: 100000 + i }));
const bad = Array.from({ length: 10 }, (_, i) => item(100 + i, "bad", { genre: i < 7 ? "Comedy" : "Drama", subgenre: i < 7 ? "Office Comedy" : "Family Drama", duration: 150 + i, hook: "Conflict in progress", pacing: "Slow", ending: "Open ending", views: 2000 + i }));

describe("DatasetBuilder", () => {
  const profile = buildDatasetProfile([...best, ...bad], [{ video_id: "x", reason: "failed" }]);

  it("summarises best vs bad, including durations", () => {
    expect(profile.overview).toMatchObject({ videos: 20, best: 10, bad: 10, excluded: 1, best_share: 0.5 });
    expect(profile.overview.duration_best.median).toBeCloseTo(59.5, 1);
    expect(profile.overview.duration_bad.median).toBeCloseTo(154.5, 1);
  });

  it("ranks genres and subgenres by (smoothed) win rate with normalised labels", () => {
    expect(profile.genres.map(g => g.genre)).toEqual(["Drama", "Comedy"]);
    const drama = profile.genres[0];
    expect(drama).toMatchObject({ total: 11, best: 8, bad: 3, win_rate: 0.727 });
    expect(drama.subgenres[0]).toMatchObject({ subgenre: "Family Drama", best: 8, bad: 3 });
    expect(profile.combos[0]).toMatchObject({ genre: "Drama", subgenre: "Family Drama" });
  });

  it("finds the duration sweet spot", () => {
    expect(profile.duration.sweet_spot.range).toBe("30–60s");
    expect(profile.duration.buckets.find(b => b.range === "120–180s")).toMatchObject({ best: 0, bad: 10 });
  });

  it("separates winning and avoid patterns by lift", () => {
    const win = profile.patterns.winning.map(p => `${p.feature}:${p.value}`);
    const avoid = profile.patterns.avoid.map(p => `${p.feature}:${p.value}`);
    expect(win).toEqual(expect.arrayContaining(["hook_pattern:Hidden secret", "pacing:Fast", "ending_type:Uplifting resolution", "dialogue_function:Reveal a hidden truth"]));
    expect(avoid).toEqual(expect.arrayContaining(["hook_pattern:Conflict in progress", "pacing:Slow", "ending_type:Open ending"]));
    expect(win).not.toContain("emotion:Curiosity"); // shared by both classes → neither
  });

  it("keeps exemplars structural (no source names, no avoid lists)", () => {
    const ex = profile.exemplars["Drama|Family Drama"];
    expect(ex.length).toBeGreaterThan(0);
    expect(JSON.stringify(ex)).not.toMatch(/Meera|avoid/);
  });

  it("builds a playbook for a brief", () => {
    const pb = playbookFor(profile, { genre: "Drama", subgenre: "Family Drama" });
    expect(pb.evidence).toMatchObject({ videos: 11, best: 8 });
    expect(pb.duration.target_seconds).toBeGreaterThanOrEqual(55);
    expect(pb.duration.target_seconds).toBeLessThanOrEqual(62);
    expect(pb.use_patterns.join(" ")).toMatch(/Hidden secret/);
    expect(pb.avoid_patterns.join(" ")).toMatch(/Slow/);
    expect(pb.structural_examples[0]).not.toHaveProperty("core_conflict");
  });

  it("flags small samples and imbalance instead of over-claiming", () => {
    const small = buildDatasetProfile([...best.slice(0, 4), ...bad.slice(0, 1)]);
    expect(small.notes.join(" ")).toMatch(/Only 5 usable videos/);
    expect(small.notes.join(" ")).toMatch(/imbalanced/);
    expect(patternLift(best).winning).toEqual([]); // needs both classes
  });

  it("normalises labels", () => {
    expect(canonical("  family  DRAMA ")).toBe("Family Drama");
    expect(canonical("")).toBe("Unspecified");
    expect(canonical("N/A")).toBe("Unspecified");
  });
});

describe("Excel performance labels", () => {
  const allowedHosts = ["facebook.com", "www.facebook.com"];
  it("parses label synonyms", () => {
    expect(["Best", "top", "1", "Viral"].map(parsePerformance)).toEqual(["best", "best", "best", "best"]);
    expect(["bad", "Flop", "0", "LOW"].map(parsePerformance)).toEqual(["bad", "bad", "bad", "bad"]);
    expect(parsePerformance("")).toBeNull();
    expect(parsePerformance("meh")).toBeUndefined();
  });

  it("requires a valid label for every row in a training dataset", () => {
    const buf = makeWorkbook([["video_url", "Performance"], ["https://www.facebook.com/reel/1000000000001", "Best"], ["https://www.facebook.com/reel/1000000000002", "bad"], ["https://www.facebook.com/reel/1000000000003", ""], ["https://www.facebook.com/reel/1000000000004", "meh"]]);
    const r = parseSpreadsheet(buf, { filename: "d.xlsx", allowedHosts, purpose: "dataset" });
    expect(r.summary).toMatchObject({ valid: 2, invalid: 2, best: 1, bad: 1 });
    expect(r.rows[2].errors[0].code).toBe("MISSING_LABEL");
    expect(r.rows[3].errors[0].code).toBe("BAD_LABEL");
    expect(() => parseSpreadsheet(makeWorkbook([["video_url"], ["https://www.facebook.com/reel/1000000000001"]]), { filename: "d.xlsx", allowedHosts, purpose: "dataset" })).toThrow(/performance/);
  });

  it("treats labels as optional for normal batches", () => {
    const r = parseSpreadsheet(makeWorkbook([["video_url", "label"], ["https://www.facebook.com/reel/1000000000001", "meh"]]), { filename: "g.xlsx", allowedHosts });
    expect(r.rows[0]).toMatchObject({ valid: true, performance: null });
    expect(r.rows[0].warnings[0]).toMatch(/performance/);
  });
});
