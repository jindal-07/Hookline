import { describe, it, expect } from "vitest";
import { layoutScreenplay, blockLines, LINES_PER_PAGE } from "../../client/src/utils/screenplayPages.js";

const scene = (n) => `## Scene ${n} - INT. Room ${n} - Night

A long action paragraph that describes what happens in this room in concrete, visual terms so that it wraps over several lines of the page. ${"More detail follows here. ".repeat(4)}

ANNA
(quietly)
This is line ${n}, and it is long enough to wrap across a couple of dialogue lines.

BEN
Short reply.
`;

const SCRIPT = `# Episode 07: The Long Night

> **Series continuity note**: Standalone episode.

## Main Characters

- **Anna**: 30s, nurse
- **Ben**: 40s, driver

${Array.from({ length: 12 }, (_, i) => scene(i + 1)).join("\n")}
FADE OUT.

## Key Beat Candidates

1. **Beat 1** (Scene 1) - Anna arrives
2. **Beat 2** (Scene 12) - Ben leaves
`;

describe("screenplay page layout", () => {
  const d = layoutScreenplay(SCRIPT);

  it("pulls the title page, cast and beat sheet out of the script body", () => {
    expect(d.title).toBe("The Long Night");
    expect(d.episode).toBe("07");
    expect(d.note).toBe("Standalone episode.");
    expect(d.cast.flat().map(c => c.name)).toEqual(["Anna", "Ben"]);
    expect(d.beats.flat().map(b => b.number)).toEqual([1, 2]);
    expect(d.body.flat().some(b => b.type === "cast" || b.type === "beat")).toBe(false);
  });

  it("paginates across several pages without overfilling any, and keeps every block", () => {
    expect(d.pageCount).toBeGreaterThan(2);
    for (const page of d.body) {
      const used = page.reduce((t, b, i) => t + blockLines(b, { first: i === 0 }), 0);
      if (page.length > 1) expect(used).toBeLessThanOrEqual(LINES_PER_PAGE);
    }
    expect(d.body.flat().filter(b => b.type === "scene")).toHaveLength(12);
    expect(d.body.flat().at(-1)).toMatchObject({ type: "transition", text: "FADE OUT." });
  });

  it("never leaves a scene heading at the bottom of a page, and indexes scenes by page", () => {
    for (const page of d.body) expect(page.at(-1).type).not.toBe("scene");
    expect(d.scenes.map(s => s.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(d.scenes[0].page).toBe(1);
    expect(d.scenes.at(-1).page).toBe(d.pageCount);
  });
});
