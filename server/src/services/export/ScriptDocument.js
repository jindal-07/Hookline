// Script downloads in industry screenplay layout (Courier 12, A4): title page, cast list, scene headings,
// full-width action, cue / parenthetical / dialogue columns, right-aligned transitions and a key-beats page.
// Word (.docx) via `docx`, PDF via `pdfkit`. Both are built from the same parsed blocks as the on-screen view.
import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
import { AlignmentType, Document, Packer, PageBreak, Paragraph, TextRun } from "docx";
import { parseScript } from "@reelscript/shared/script";
import { badRequest } from "../../utils/errors.js";

const plain = (s) => String(s ?? "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*\*/g, "");
const sceneLine = (b) => `${b.number != null ? `${b.number}. ` : ""}${b.stamp ? `[${b.stamp}] ` : ""}${b.setting}${b.time ? ` — ${b.time}` : ""}`.toUpperCase();

/** Title, subtitle and the body blocks (title/note blocks are moved to the title page). */
function prepare(script) {
  const blocks = parseScript(script.content);
  const titleBlock = blocks.find(b => b.type === "title");
  const title = script.title || titleBlock?.text || "Untitled episode";
  const brief = script.brief || {};
  const subtitle = [brief.genre, brief.subgenre].filter(Boolean).join(" · ");
  const body = blocks.filter(b => b.type !== "title" && !(b.type === "note" && /continuity/i.test(b.text)));
  return { title, subtitle, episode: titleBlock?.episode || null, body };
}

export function scriptFileName(script, ext) {
  const base = (script.title || `script-${String(script.id).slice(0, 8)}`).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "script";
  return `${base}.${ext}`;
}

// ---------------------------------------------------------------- Word (.docx)
const TW = 1440; // twips per inch
const FONT = "Courier New";
const run = (text, o = {}) => new TextRun({ text, font: FONT, size: 24, ...o });
const para = (children, o = {}) => new Paragraph({ children: [].concat(children), spacing: { after: 240 }, ...o });

export async function scriptToDocx(script) {
  const { title, subtitle, episode, body } = prepare(script);
  const out = [
    para(run(""), { spacing: { before: 3 * TW } }),
    para(run(title.toUpperCase(), { bold: true }), { alignment: AlignmentType.CENTER }),
    ...(episode ? [para(run(`Episode ${episode}`), { alignment: AlignmentType.CENTER })] : []),
    ...(subtitle ? [para(run(subtitle), { alignment: AlignmentType.CENTER })] : []),
    para(run("Standalone episode"), { alignment: AlignmentType.CENTER }),
    para(new PageBreak()),
  ];
  let section = null;
  for (const b of body) {
    switch (b.type) {
      case "section":
        section = b.kind;
        if (b.kind === "beats") out.push(para(new PageBreak()));
        out.push(para(run(b.text.toUpperCase(), { bold: true, underline: {} }), { keepNext: true }));
        break;
      case "cast":
        out.push(para([run(`${b.name.toUpperCase()} — `, { bold: true }), run(plain(b.text))], { spacing: { after: 120 } }));
        break;
      case "scene":
        if (section === "cast") out.push(para(run(""), { spacing: { after: 240 } }));
        section = "body";
        out.push(para(run(sceneLine(b), { bold: true }), { keepNext: true, spacing: { before: 240, after: 240 } }));
        break;
      case "action": case "bullet": case "numbered": case "note": case "subheading":
        out.push(para(run(plain(b.text))));
        break;
      case "dialogue":
        out.push(para(run(`${b.name}${b.ext ? ` (${b.ext})` : ""}`.toUpperCase()), { indent: { left: 2.2 * TW }, keepNext: true, spacing: { after: 0 } }));
        b.parts.forEach((p, i) => {
          const last = i === b.parts.length - 1;
          out.push(p.kind === "paren"
            ? para(run(p.text), { indent: { left: 1.6 * TW, right: 2 * TW }, keepNext: !last, spacing: { after: last ? 240 : 0 } })
            : para(run(plain(p.text)), { indent: { left: 1 * TW, right: 1.5 * TW }, keepNext: !last, spacing: { after: last ? 240 : 0 } }));
        });
        break;
      case "transition":
        out.push(para(run(b.text.toUpperCase()), { alignment: AlignmentType.RIGHT }));
        break;
      case "beat":
        out.push(para([run(`${b.number}. `, { bold: true }), run(`${b.scene ? `(${b.scene}) ` : ""}${plain(b.text)}`)], { spacing: { after: 120 } }));
        break;
      default:
    }
  }
  const doc = new Document({
    creator: "Hookline",
    title,
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: TW, bottom: TW, left: 1.5 * TW, right: TW } } }, children: out }],
  });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------- PDF
// Standard PDF fonts cover Western European text only. For anything else (e.g. Hindi), a Unicode font is needed.
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const needsUnicodeFont = (text) => [...text].some(ch => ch.charCodeAt(0) > 0xff && !WIN_ANSI_EXTRA.includes(ch));
// { path, family } — family selects one face from a .ttc collection.
const UNICODE_FONT_CANDIDATES = [
  process.env.PDF_FONT_PATH && { path: process.env.PDF_FONT_PATH, family: process.env.PDF_FONT_FAMILY || undefined },
  { path: "C:/Windows/Fonts/Nirmala.ttc", family: "NirmalaUI" }, { path: "C:/Windows/Fonts/Nirmala.ttf" },
  { path: "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf" }, { path: "/usr/share/fonts/noto/NotoSans-Regular.ttf" },
  { path: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" }, { path: "/Library/Fonts/Arial Unicode.ttf" },
].filter(Boolean);

export const unicodePdfFont = () => UNICODE_FONT_CANDIDATES.find(f => existsSync(f.path) && (/\.(ttf|otf)$/i.test(f.path) || f.family)) || null;

export async function scriptToPdf(script) {
  const { title, subtitle, episode, body } = prepare(script);
  let fonts = { regular: "Courier", bold: "Courier-Bold", italic: "Courier-Oblique" };
  const unicode = needsUnicodeFont(script.content + title) ? unicodePdfFont() : null;
  if (needsUnicodeFont(script.content + title) && !unicode)
    throw badRequest("This script uses characters the built-in PDF fonts can't show. Download the Word (.docx) version, or set PDF_FONT_PATH to a Unicode .ttf font on the server.");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 72, bottom: 72, left: 108, right: 72 }, bufferPages: true, info: { Title: title, Creator: "Hookline" } });
    if (unicode) {
      doc.registerFont("Unicode", unicode.path, unicode.family);
      fonts = { regular: "Unicode", bold: "Unicode", italic: "Unicode" };
    }
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const LINE = 14.4; // 12pt Courier, single spaced
    const gap = () => doc.moveDown(1);
    const fits = (h) => doc.y + h <= doc.page.height - doc.page.margins.bottom;
    const text = (s, { font = fonts.regular, x = L, width = W, align = "left" } = {}) => doc.font(font).fontSize(12).text(s, x, doc.y, { width, align, lineGap: 2.4 });

    // Title page
    doc.y = doc.page.height / 3;
    text(title.toUpperCase(), { font: fonts.bold, align: "center" });
    gap();
    if (episode) text(`Episode ${episode}`, { align: "center" });
    if (subtitle) text(subtitle, { align: "center" });
    text("Standalone episode", { align: "center" });
    doc.addPage();

    let section = null;
    for (const b of body) {
      switch (b.type) {
        case "section":
          section = b.kind;
          if (b.kind === "beats") doc.addPage();
          text(b.text.toUpperCase(), { font: fonts.bold });
          gap();
          break;
        case "cast":
          text(`${b.name.toUpperCase()} — ${plain(b.text)}`);
          doc.moveDown(0.5);
          break;
        case "scene":
          if (section === "cast") gap();
          section = "body";
          if (!fits(LINE * 4)) doc.addPage(); // keep a heading with the start of its scene
          gap();
          text(sceneLine(b), { font: fonts.bold });
          gap();
          break;
        case "action": case "bullet": case "numbered": case "note": case "subheading":
          text(plain(b.text));
          gap();
          break;
        case "dialogue":
          if (!fits(LINE * 3)) doc.addPage(); // never strand a cue at the bottom of a page
          text(`${b.name}${b.ext ? ` (${b.ext})` : ""}`.toUpperCase(), { x: L + 158, width: W - 158 });
          for (const p of b.parts)
            p.kind === "paren"
              ? text(p.text, { font: fonts.italic, x: L + 115, width: 145 })
              : text(plain(p.text), { x: L + 72, width: 252 });
          gap();
          break;
        case "transition":
          text(b.text.toUpperCase(), { align: "right" });
          gap();
          break;
        case "beat":
          text(`${b.number}. ${b.scene ? `(${b.scene}) ` : ""}${plain(b.text)}`);
          doc.moveDown(0.5);
          break;
        default:
      }
    }

    // Page numbers (top right), skipping the title page
    const range = doc.bufferedPageRange();
    for (let i = 1; i < range.count; i++) {
      doc.switchToPage(i);
      doc.font(fonts.regular).fontSize(12).text(`${i}.`, L, 36, { width: W, align: "right", lineBreak: false });
    }
    doc.end();
  });
}
