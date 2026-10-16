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
