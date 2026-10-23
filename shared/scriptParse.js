// Parses the scriptwriter skill's Markdown screenplay into typed blocks for display:
// title, note, section, cast, scene heading, action, dialogue (cue + parentheticals + lines), transition, beat.
// Pure and dependency-free so it can be unit-tested.

const SCENE_MD = /^##\s+Scene\s+(\d+)\s*[-–—:]\s*(.+)$/i;
const SCENE_PLAIN = /^(?:\*\*)?\s*(?:\[([^\]]+)\]\s*)?((?:INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E|INT\.|EXT\.)\s+.+?)(?:\*\*)?$/;
const TRANSITION = /^(?:FADE (?:OUT|IN|TO BLACK)|CUT TO|SMASH CUT(?: TO)?|DISSOLVE TO|MATCH CUT(?: TO)?|CUT TO BLACK|THE END)\b[^a-z]*$/;
const CUE = /^([A-Z][A-Z0-9 .'’&-]{0,40}?)\s*(?:\(([^)]*)\))?\s*:?$/;
const PAREN = /^\(.*\)$/;

const isCue = (line) => {
  const m = line.match(CUE);
  if (!m) return null;
  const name = m[1].trim();
  if ((name.match(/[A-Z]/g) || []).length < 2 || name.split(/\s+/).length > 5 || TRANSITION.test(line)) return null;
  return { name, ext: m[2] ? m[2].trim() : null };
};

/** "INT. Bank - Teller Counter - Friday Afternoon" → { setting, time } (the last " - " part is the time). */
export function splitHeading(rest) {
  const parts = rest.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return { setting: rest.trim(), time: null };
  const time = parts.pop();
  return { setting: parts.join(" — "), time };
}

export function parseScript(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let mode = "body"; // body | cast | beats
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: "action", text: para.join(" ") }); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^---+$/.test(line)) { flush(); continue; }

    let m;
    if ((m = line.match(/^#\s+(.+)$/))) { flush(); blocks.push({ type: "title", text: m[1].replace(/^Episode\s+\d+:\s*/i, "") , episode: m[1].match(/^Episode\s+(\d+)/i)?.[1] || null }); continue; }
    if (/^>\s?/.test(line)) {
      flush();
      const t = line.replace(/^>\s?/, "");
      const prev = blocks.at(-1);
      if (prev?.type === "note") prev.text += " " + t; else blocks.push({ type: "note", text: t });
      continue;
    }
    if ((m = line.match(SCENE_MD))) { flush(); mode = "body"; blocks.push({ type: "scene", number: Number(m[1]), ...splitHeading(m[2]) }); continue; }
    if ((m = line.match(/^##\s+(.+)$/))) {
      flush();
      const title = m[1].trim();
      mode = /\blocations?\b|\bsettings?\b|\bsets\b/i.test(title) ? "locations" : /main characters|cast|characters/i.test(title) ? "cast" : /beat/i.test(title) ? "beats" : "body";
      blocks.push({ type: "section", text: title, kind: mode });
      continue;
    }
    if ((m = line.match(/^###\s+(.+)$/))) { flush(); blocks.push({ type: "subheading", text: m[1] }); continue; }
    if ((m = line.match(SCENE_PLAIN)) && !/[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/.test(m[2])) { flush(); blocks.push({ type: "scene", number: null, stamp: m[1] || null, ...splitHeading(m[2]) }); continue; }

    if ((m = line.match(/^\s*[-*]\s+(.+)$/))) {
      flush();
      const item = m[1];
      const cm = item.match(/^\*\*(.+?)\*\*\s*[:—–-]\s*(.+)$/);
      if (mode === "cast" && cm) blocks.push({ type: "cast", name: cm[1], text: cm[2] });
      else if (mode === "locations" && cm) blocks.push({ type: "location", name: cm[1], text: cm[2] });
      else blocks.push({ type: "bullet", text: item });
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.+)$/))) {
      flush();
      const bm = m[1].match(/^\*\*Beat\s+(\d+)\*\*\s*(?:\((Scene[^)]*)\))?\s*[-–—:]?\s*(.*)$/i);
      if (bm) blocks.push({ type: "beat", number: Number(bm[1]), scene: bm[2] || null, text: bm[3] });
      else blocks.push({ type: "numbered", text: m[1] });
      continue;
    }
    if (TRANSITION.test(line)) { flush(); blocks.push({ type: "transition", text: line.replace(/\*\*/g, "") }); continue; }

    // Dialogue: a CHARACTER cue followed directly by spoken lines (and parentheticals) until a blank line.
    const cue = isCue(line.replace(/\*\*/g, ""));
    const next = lines[i + 1]?.trim();
    if (cue && next && !next.startsWith("#") && !isCue(next)) {
      flush();
      const parts = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l || l.startsWith("#") || /^---+$/.test(l) || isCue(l) || TRANSITION.test(l)) break;
        if (PAREN.test(l)) parts.push({ kind: "paren", text: l });
        else if (parts.at(-1)?.kind === "line") parts.at(-1).text += " " + l;
        else parts.push({ kind: "line", text: l });
      }
      blocks.push({ type: "dialogue", name: cue.name, ext: cue.ext, parts });
      i = j - 1;
      continue;
    }

    para.push(line);
  }
  flush();
  return blocks;
}

const HONORIFIC = /^(mr|mrs|ms|miss|dr|judge|sgt|sergeant|officer|captain|capt|inspector|detective|det|agent|prof|professor|sir|lady|lord|aunt|uncle|grandma|grandpa)\.?$/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "INT. County Spelling Bee — Stage" → "COUNTY SPELLING BEE STAGE" (for matching locations to scene headings). */
const placeKey = (s) => String(s || "").toUpperCase()
  .replace(/^(INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|I\/E|INT\.|EXT\.)\s*/, "")
  .replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Character and location references for a parsed script, each with the scenes it appears in.
 * Locations come from a "Locations" section; scripts written without one get them from their scene headings,
 * described by the first action paragraph of the first scene at that place (marked derived).
 */
export function scriptReferences(blocks) {
  const scenes = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === "scene") { cur = { number: b.number ?? scenes.length + 1, setting: b.setting, time: b.time, text: [], firstAction: null }; scenes.push(cur); continue; }
    if (b.type === "section" && b.kind !== "body") { cur = null; continue; }
    if (!cur) continue;
    if (b.type === "action" && !cur.firstAction) cur.firstAction = b.text;
    cur.text.push(b.type === "dialogue" ? [b.name, ...b.parts.map(p => p.text)].join(" ") : b.text || "");
  }

  let locations = blocks.filter(b => b.type === "location").map(l => ({ name: l.name, text: l.text, derived: false }));
  if (!locations.length) {
    const seen = new Map();
    for (const s of scenes) if (!seen.has(placeKey(s.setting))) seen.set(placeKey(s.setting), { name: s.setting, text: s.firstAction || "", derived: true });
    locations = [...seen.values()];
  }
  locations = locations.map(l => {
    const k = placeKey(l.name);
    const used = scenes.filter(s => { const sk = placeKey(s.setting); return sk === k || (k.length >= 4 && sk.includes(k)); });
    return { ...l, scenes: used.map(s => s.number), times: [...new Set(used.map(s => s.time).filter(Boolean))] };
  });

  const cast = blocks.filter(b => b.type === "cast").map(c => {
    const words = c.name.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}'’-]/gu, "")).filter(w => w && !HONORIFIC.test(w));
    const keys = [...new Set([words[0], words.at(-1)].filter(w => w && w.length > 2))];
    const used = scenes.filter(s => keys.some(k => new RegExp(`(^|[^\\p{L}])${escapeRe(k)}([^\\p{L}]|$)`, "iu").test(s.text.join(" "))));
    return { name: c.name, text: c.text, scenes: used.map(s => s.number) };
  });

  return { cast, locations, locationsDerived: locations.some(l => l.derived) };
}
