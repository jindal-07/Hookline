// Lays a parsed script out as screenplay pages (US letter, Courier 12pt): title page, cast, numbered body pages,
// beat sheet. Page breaks are estimated from line counts (60 chars per action line, 35 per dialogue line,
// 25 per parenthetical) — the usual page-a-minute approximation, not a typesetter.
import { parseScript, scriptReferences } from "@reelscript/shared/script";

export const LINES_PER_PAGE = 43;          // 9in of text at the on-screen line height
const WIDTH = { action: 60, dialogue: 35, paren: 25 };
const plain = (s) => String(s ?? "").replace(/\*\*(.+?)\*\*/g, "$1");
const wrap = (text, width) => Math.max(1, Math.ceil((plain(text).length * 1.04) / width)); // ~4% word-wrap slack
// Spacing in line units: blocks are separated by a 1em margin, and a line is 1.25em tall (see .sp-page in styles.css).
const GAP = 1 / 1.25;
const DIALOGUE_PAD = 0.8 / 1.25; // the dialogue panel's top + bottom padding (.sp-dialogue)

/** Height of one body block in lines, including the blank line(s) that follow it. */
export function blockLines(b, { first = false } = {}) {
  switch (b.type) {
    case "scene": return (first ? 0 : 2 * GAP) + wrap(`${b.setting} ${b.time || ""}`, WIDTH.action) + GAP;
    case "dialogue": return DIALOGUE_PAD + 1 + b.parts.reduce((t, p) => t + wrap(p.text, p.kind === "paren" ? WIDTH.paren : WIDTH.dialogue), 0) + GAP;
    case "transition": return 1 + 2 * GAP;
    default: return wrap(b.text || "", WIDTH.action) + GAP;
  }
}

function paginate(blocks) {
  const pages = [];
  let page = [], used = 0;
  const push = () => { if (page.length) pages.push(page); page = []; used = 0; };
  blocks.forEach((b, i) => {
    let h = blockLines(b, { first: page.length === 0 });
    // keep a scene heading on the same page as the start of its scene
    const next = blocks[i + 1];
    // (blocks are never split, so the whole next block must fit; a block taller than a page is placed anyway)
    const need = b.type === "scene" && next ? h + Math.min(blockLines(next), LINES_PER_PAGE - h) : h;
    if (page.length && used + need > LINES_PER_PAGE) { push(); h = blockLines(b, { first: true }); }
    page.push(b);
    used += h;
  });
  push();
  return pages;
}

/** Reference entries (name line, description, scenes line, gap) packed into pages by estimated height. */
function paginateRefs(entries) {
  const pages = [];
  let page = [], used = 2; // the page title + its gap
  for (const e of entries) {
    const h = 1 + wrap(e.text || "", WIDTH.action) + (e.scenes?.length ? 1 : 0) + 1.5 * GAP;
    if (page.length && used + h > LINES_PER_PAGE) { pages.push(page); page = []; used = 2; }
    page.push(e);
    used += h;
  }
  if (page.length) pages.push(page);
  return pages;
}

/**
 * @returns {{ title, episode, note, cast: object[][], body: object[][], beats: object[][], scenes: {number,setting,time,page}[], pageCount }}
 * cast/body/beats are arrays of pages (each an array of blocks). Body pages are numbered from 1.
 */
export function layoutScreenplay(text) {
  const blocks = parseScript(text);
  const titleBlock = blocks.find(b => b.type === "title");
  const note = blocks.find(b => b.type === "note")?.text?.replace(/^\*\*[^*]+\*\*:?\s*/, "") || null;
  const beats = [], body = [];
  let section = "body";
  for (const b of blocks) {
    if (b.type === "title" || b.type === "note") continue;
    if (b.type === "section") { section = b.kind; if (b.kind === "body") body.push({ ...b, type: "subheading" }); continue; }
    if (b.type === "scene") section = "body";
    if ((section === "cast" || section === "locations") && (b.type === "cast" || b.type === "location" || b.type === "bullet")) continue;
    else if (section === "beats" && (b.type === "beat" || b.type === "numbered")) beats.push(b);
    else body.push(b);
  }
  const refs = scriptReferences(blocks);
  const bodyPages = paginate(body);
  const scenes = [];
  bodyPages.forEach((p, i) => p.forEach(b => { if (b.type === "scene") scenes.push({ number: b.number ?? scenes.length + 1, setting: b.setting, time: b.time, page: i + 1 }); }));
  return {
    title: titleBlock?.text || null,
    episode: titleBlock?.episode || null,
    note,
    cast: paginateRefs(refs.cast),
    locations: paginateRefs(refs.locations),
    locationsDerived: refs.locationsDerived,
    body: bodyPages,
    beats: paginateRefs(beats.map(b => ({ ...b, scenes: null }))),
    scenes,
    pageCount: bodyPages.length,
  };
}
