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
      mode = /main characters|cast|characters/i.test(title) ? "cast" : /beat/i.test(title) ? "beats" : "body";
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
