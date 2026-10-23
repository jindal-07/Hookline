import { describe, it, expect } from "vitest";
import { parseScript, splitHeading } from "../../shared/scriptParse.js";

const SCRIPT = `# Episode 01: Final Word

> **Series continuity note**: Standalone episode.

## Main Characters

- **Noor Rahimi**: 12, refugee student, long dark braid
- **Judge Harlan Voss**: 60s, head judge, bow tie

## Scene 1 - INT. County Spelling Bee - School Auditorium Stage - Afternoon

A school auditorium hung with a banner. Two contestants remain on stage.

NOOR RAHIMI (12, long dark braid) steps to the microphone.

PRONOUNCER
Your word is "chiaroscuro."

JUDGE VOSS (CONT'D)
(not covering his)
Stop. Number seventeen,
what is that in your ear?

VOICE (V.O.)
Valid.

FADE OUT.

---

## Key Beat Candidates

1. **Beat 1** (Scene 1) - Judge Voss rings the bell
2. **Beat 2** (Scene 2) - He mocks her English`;

describe("script parser", () => {
  const blocks = parseScript(SCRIPT);
  const of = (t) => blocks.filter(b => b.type === t);

  it("separates scene headings, action, dialogue and transitions", () => {
    expect(of("title")[0]).toMatchObject({ text: "Final Word", episode: "01" });
    expect(of("note")[0].text).toMatch(/Standalone episode/);
    expect(of("scene")[0]).toEqual({ type: "scene", number: 1, setting: "INT. County Spelling Bee — School Auditorium Stage", time: "Afternoon" });
    expect(of("action").map(a => a.text)).toEqual([
      "A school auditorium hung with a banner. Two contestants remain on stage.",
      "NOOR RAHIMI (12, long dark braid) steps to the microphone.", // a character intro is action, not a cue
    ]);
    expect(of("dialogue")).toEqual([
      { type: "dialogue", name: "PRONOUNCER", ext: null, parts: [{ kind: "line", text: 'Your word is "chiaroscuro."' }] },
      { type: "dialogue", name: "JUDGE VOSS", ext: "CONT'D", parts: [{ kind: "paren", text: "(not covering his)" }, { kind: "line", text: "Stop. Number seventeen, what is that in your ear?" }] },
      { type: "dialogue", name: "VOICE", ext: "V.O.", parts: [{ kind: "line", text: "Valid." }] },
    ]);
    expect(of("transition")[0].text).toBe("FADE OUT.");
  });

  it("reads the cast list and beat timeline", () => {
    expect(of("cast").map(c => c.name)).toEqual(["Noor Rahimi", "Judge Harlan Voss"]);
    expect(of("beat")).toEqual([
      { type: "beat", number: 1, scene: "Scene 1", text: "Judge Voss rings the bell" },
      { type: "beat", number: 2, scene: "Scene 2", text: "He mocks her English" },
    ]);
  });

  it("splits headings into setting and time", () => {
    expect(splitHeading("EXT. Downtown Bus Stop - Rainy Morning")).toEqual({ setting: "EXT. Downtown Bus Stop", time: "Rainy Morning" });
    expect(splitHeading("INT. Kitchen")).toEqual({ setting: "INT. Kitchen", time: null });
  });
});

describe("character and location references", () => {
  const WITH_REFS = `# Episode 02: The Ramp

## Main Characters

- **Desmond Webb**: 30s, wheelchair user, white shirt and tie
- **Judge Harlan Voss**: 60s, bow tie, white mustache

## Locations

- **EXT. Downtown Bus Stop**: glass shelter, rain on the roof, sodium light
- **INT. Route 9 Bus**: blue seats, ramp panel by the door

## Scene 1 - EXT. Downtown Bus Stop - Rainy Morning

Desmond rolls to the curb.

## Scene 2 - INT. Route 9 Bus - Moving

JUDGE VOSS
Remove it.

## Scene 3 - EXT. Downtown Bus Stop - Later

The rain stops.`;

  it("reads the Locations section and lists the scenes each character and location appears in", async () => {
    const { parseScript, scriptReferences } = await import("../../shared/scriptParse.js");
    const blocks = parseScript(WITH_REFS);
    expect(blocks.filter(b => b.type === "location").map(l => l.name)).toEqual(["EXT. Downtown Bus Stop", "INT. Route 9 Bus"]);
    expect(blocks.some(b => b.type === "action" && /glass shelter/.test(b.text))).toBe(false); // references stay out of the body
    const r = scriptReferences(blocks);
    expect(r.locationsDerived).toBe(false);
    expect(r.locations.map(l => [l.name, l.scenes, l.times])).toEqual([
      ["EXT. Downtown Bus Stop", [1, 3], ["Rainy Morning", "Later"]],
      ["INT. Route 9 Bus", [2], ["Moving"]],
    ]);
    expect(r.cast.map(c => [c.name, c.scenes])).toEqual([["Desmond Webb", [1]], ["Judge Harlan Voss", [2]]]); // "Judge" ignored, matched by VOSS
  });

  it("derives locations from scene headings when the script has no Locations section", async () => {
    const { parseScript, scriptReferences } = await import("../../shared/scriptParse.js");
    const r = scriptReferences(parseScript(WITH_REFS.replace(/## Locations[\s\S]*?(?=## Scene 1)/, "")));
    expect(r.locationsDerived).toBe(true);
    expect(r.locations.map(l => [l.name, l.text, l.scenes])).toEqual([
      ["EXT. Downtown Bus Stop", "Desmond rolls to the curb.", [1, 3]],
      ["INT. Route 9 Bus", "", [2]],
    ]);
  });
});
