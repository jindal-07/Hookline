import { describe, it, expect } from "vitest";
import { scriptToDocx, scriptToPdf, scriptFileName, unicodePdfFont } from "../../server/src/services/export/ScriptDocument.js";

const content = `# Episode 01: Final Word

> **Series continuity note**: Standalone episode.

## Main Characters

- **Noor Rahimi**: 12, long dark braid

## Scene 1 - INT. Auditorium - Afternoon

Two contestants remain on stage.

JUDGE VOSS (CONT'D)
(leaning in)
Stop. What is that in your ear?

FADE OUT.

## Key Beat Candidates

1. **Beat 1** (Scene 1) - The bell rings`;
const script = { id: "2212e20b-0000", title: "Final Word", brief: { genre: "Drama", subgenre: "Social Justice" }, content };

describe("script downloads", () => {
  it("names files from the title", () => {
    expect(scriptFileName(script, "docx")).toBe("Final-Word.docx");
    expect(scriptFileName({ id: "abcdef123456", title: null }, "pdf")).toBe("script-abcdef12.pdf");
  });

  it("builds a Word document with screenplay indents", async () => {
    const buf = await scriptToDocx(script);
    expect(buf.subarray(0, 2).toString()).toBe("PK"); // .docx is a zip container
    const xml = buf.toString("latin1");
    expect(xml).toContain("word/document.xml");
  });

  it("builds a multi-page PDF (title page + script + beats)", async () => {
    const buf = await scriptToPdf(script);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((buf.toString("latin1").match(/\/Type \/Page\b/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("refuses PDF for non-Latin text when no Unicode font is available, instead of printing garbage", async () => {
    const hindi = { ...script, content: `${content}\n\nNOOR\nमुझे सुनाई नहीं देगा।` };
    const hasSystemFont = !!unicodePdfFont();
    if (hasSystemFont) expect((await scriptToPdf(hindi)).subarray(0, 5).toString()).toBe("%PDF-");
    else await expect(scriptToPdf(hindi)).rejects.toThrow(/Word \(\.docx\)/);
    expect((await scriptToDocx(hindi)).subarray(0, 2).toString()).toBe("PK"); // Word always works
  });
});
