import { describe, it, expect } from "vitest";
import { fixMojibake, parseDuration, screenplayDuration, dialogueFromScreenplay, turnsFromTranscript, guessLanguage, rawTranscriptFromText } from "../../server/src/services/importing/textImport.js";
import { parseSpreadsheet } from "../../server/src/services/excel/ExcelParser.js";
import { TranscriptNormalizer } from "../../server/src/services/normalization/TranscriptNormalizer.js";
import { validate } from "../../server/src/utils/schema.js";

const HOSTS = ["facebook.com", "www.facebook.com"];
const SCREENPLAY = `**LOGLINE**
A veteran sergeant‚Äôs biased stop backfires.

**[00:00 - 00:33] EXT. RESIDENTIAL STREET - DAY**

SERGEANT GREEN (60s, stern) stands by the window.

SGT. GREEN
License, registration and proof of insurance, please.

MR. PORTER
(Slightly incredulous)
No, sir.

**[01:38 - 02:45] EXT. STREET - CONTINUOUS**

CAPTAIN
That‚Äôs my son ‚Äî why is he in handcuffs?

FADE OUT.`;

describe("text import helpers", () => {
  it("repairs mis-decoded punctuation and leaves Hindi alone", () => {
    expect(fixMojibake("That‚Äôs it ‚Äî ‚Äúok‚Äù")).toBe("That’s it — “ok”");
    expect(fixMojibake("क्या हुआ")).toBe("क्या हुआ");
  });

  it("parses durations in the usual formats", () => {
    expect(parseDuration(345)).toBe(345);
    expect(parseDuration("302")).toBe(302);
    expect(parseDuration("5:02")).toBe(302);
    expect(parseDuration("1m 15s")).toBe(75);
    expect(parseDuration("2 min")).toBe(120);
    expect(parseDuration("n/a")).toBeNull();
    expect(screenplayDuration(SCREENPLAY)).toBe(165);
  });

  it("extracts dialogue from a screenplay, skipping headings and parentheticals", () => {
    const d = dialogueFromScreenplay(fixMojibake(SCREENPLAY));
    expect(d).toEqual([
      { speaker: "SGT. GREEN", text: "License, registration and proof of insurance, please." },
      { speaker: "MR. PORTER", text: "No, sir." },
      { speaker: "CAPTAIN", text: "That’s my son — why is he in handcuffs?" },
    ]);
  });

  it("splits plain transcripts into turns and reads NAME: / [mm:ss] prefixes", () => {
    expect(turnsFromTranscript("A: Hello there\nB: Hi")).toEqual([{ text: "Hello there", speaker: "A", time: null }, { text: "Hi", speaker: "B", time: null }]);
    expect(turnsFromTranscript("[00:05] Step out of the car.")[0]).toMatchObject({ text: "Step out of the car.", time: 5 });
    const long = "Step out of the car. ".repeat(30).trim();
    expect(turnsFromTranscript(long).length).toBe(30);
  });

  it("guesses Hindi for Devanagari or Hinglish, English otherwise", () => {
    expect(guessLanguage("तुम कहाँ हो")).toBe("hi");
    expect(guessLanguage("tum kya kar rahe ho yaar, main nahi aaunga")).toBe("hi");
    expect(guessLanguage("Step out of the car, I am the law.")).toBe("en");
  });

  it("builds a valid normalized transcript from text (transcript, or screenplay dialogue as fallback)", async () => {
    for (const input of [{ transcript: "Step out of the car. That is not the law. I am the law.", screenplay: SCREENPLAY, durationSeconds: 120 }, { transcript: "", screenplay: fixMojibake(SCREENPLAY), durationSeconds: 165 }]) {
      const b = rawTranscriptFromText(input);
      const n = await new TranscriptNormalizer().normalize({ raw: b.raw, sentences: b.sentences, videoId: "v1" });
      expect(validate("transcript", n).valid).toBe(true);
      expect(n.duration_seconds).toBe(input.durationSeconds);
      expect(n.dialogue_segments.length + n.narration_segments.length).toBeGreaterThan(2);
    }
    expect(rawTranscriptFromText({ transcript: "", screenplay: SCREENPLAY, durationSeconds: 165 }).speakers).toEqual(["SGT. GREEN", "MR. PORTER", "CAPTAIN"]);
  });
});

describe("spreadsheet import columns", () => {
  const csv = (rows) => Buffer.from("﻿" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n"), "utf8");
  const sheet = csv([
    ["video_number", "title", "video_url", "duration_sec", "transcript", "screenplay", "Performance"],
    [1, "Cop Handcuffs Captain‚Äôs Son", "https://www.facebook.com/reel/1234567890", "302", "Step out of the car.", SCREENPLAY, "Best"],
    [2, "No text row", "https://www.facebook.com/reel/1234567891", "", "", "", "Bad"],
  ]);

  it("reads UTF-8 CSV with a BOM, repairs text and attaches transcript/screenplay to dataset rows", () => {
    const p = parseSpreadsheet(sheet, { filename: "Book 4(Sheet1).csv", purpose: "dataset", allowedHosts: HOSTS });
    expect(p.file_type).toBe("csv");
    expect(p.summary).toMatchObject({ total_rows: 2, valid: 2, best: 1, bad: 1, imported: 1 });
    expect(p.columns.import_found).toEqual(["screenplay", "transcript", "duration"]);
    const [a, b] = p.rows;
    expect(a.title).toBe("Cop Handcuffs Captain’s Son");
    expect(a.import).toMatchObject({ transcript: "Step out of the car.", duration: 302 });
    expect(a.import.screenplay).toContain("That’s my son");
    expect(b.import).toBeUndefined();
    expect(b.warnings[0]).toMatch(/downloaded and analysed/);
  });

  it("ignores text columns for generation batches", () => {
    const p = parseSpreadsheet(sheet, { filename: "x.csv", purpose: "generation", allowedHosts: HOSTS });
    expect(p.rows[0].import).toBeUndefined();
    expect(p.summary.imported).toBeUndefined();
  });

  it("rejects binary files posing as CSV", () => {
    expect(() => parseSpreadsheet(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), { filename: "x.csv" })).toThrow(/valid CSV/);
  });
});
