// Deterministic clean-up of a schema-valid screenplay analysis: clamps times, orders scenes,
// fixes dangling character references and records every repair for auditability.

const r2 = n => Math.round(n * 100) / 100;

export function normalizeScreenplay(analysis, { durationSeconds } = {}) {
  const a = structuredClone(analysis);
  const repairs = [];
  const dur = durationSeconds || a.metadata.duration_seconds || Math.max(0, ...a.scenes.map(s => s.end_time));
  if (!a.metadata.duration_seconds && dur) { a.metadata.duration_seconds = r2(dur); repairs.push("metadata.duration_seconds filled from media probe"); }
  const clamp = (t, label) => {
    if (typeof t !== "number" || Number.isNaN(t)) { repairs.push(`${label}: missing time set to 0`); return 0; }
    if (t < 0) { repairs.push(`${label}: negative time clamped`); return 0; }
    if (dur && t > dur + 1) { repairs.push(`${label}: time beyond video end clamped`); return r2(dur); }
    return r2(t);
  };

  // Characters: unique ids
  const ids = new Set();
  a.characters.forEach((c, i) => {
    if (!c.character_id || ids.has(c.character_id)) {
      const fresh = `CHAR_${String(i + 1).padStart(3, "0")}`;
      repairs.push(`character "${c.label}" id ${c.character_id || "(empty)"} → ${fresh}`);
      c.character_id = fresh;
    }
    ids.add(c.character_id);
  });
  const known = id => ids.has(id);

  // Scenes: clamp, order, sane ranges, valid character refs
  a.scenes.forEach((s, i) => {
    s.start_time = clamp(s.start_time, `scene ${i + 1} start`);
    s.end_time = clamp(s.end_time, `scene ${i + 1} end`);
    if (s.end_time < s.start_time) { [s.start_time, s.end_time] = [s.end_time, s.start_time]; repairs.push(`scene ${i + 1}: start/end swapped`); }
    const before = s.characters.length;
    s.characters = [...new Set(s.characters)].filter(known);
    if (s.characters.length !== before) repairs.push(`scene ${i + 1}: removed unknown/duplicate character refs`);
  });
  a.scenes.sort((x, y) => x.start_time - y.start_time);
  a.scenes.forEach((s, i) => { s.scene_id = `SCENE_${String(i + 1).padStart(3, "0")}`; });

  a.narrative_beats.forEach((b, i) => { b.timestamp = clamp(b.timestamp, `beat ${i + 1}`); b.characters = b.characters.filter(known); });
  a.narrative_beats.sort((x, y) => x.timestamp - y.timestamp);
  a.dialogue_moments.forEach((m, i) => { m.timestamp = clamp(m.timestamp, `dialogue moment ${i + 1}`); });
  a.dialogue_moments.sort((x, y) => x.timestamp - y.timestamp);
  for (const c of a.characters) c.relationships = c.relationships.filter(r => known(r.character_id) && r.character_id !== c.character_id);

  // Story structure: one entry per element (keep first)
  const seen = new Set();
  a.story_structure = a.story_structure.filter(e => (seen.has(e.element) ? (repairs.push(`duplicate story element ${e.element} dropped`), false) : seen.add(e.element)));

  const evidence = {
    scene_count: a.scenes.length,
    character_count: a.characters.length,
    beat_count: a.narrative_beats.length,
    dialogue_moment_count: a.dialogue_moments.length,
    has_dialogue: a.dialogue_moments.length > 0 || a.scenes.some(s => s.dialogue_summary?.trim()),
    present_elements: a.story_structure.filter(e => e.status === "present").map(e => e.element),
  };
  return { analysis: a, repairs, evidence };
}

/** Merge per-chunk analyses of a long video (times offset to absolute). */
export function mergeChunkAnalyses(parts, totalDuration) {
  const first = parts[0].analysis;
  const merged = structuredClone(first);
  merged.metadata.duration_seconds = totalDuration;
  merged.scenes = []; merged.narrative_beats = []; merged.dialogue_moments = []; merged.characters = [];
  const byLabel = new Map();
  for (const { offset, analysis } of parts) {
    const idMap = new Map();
    for (const c of analysis.characters) {
      const key = c.label.trim().toLowerCase();
      if (!byLabel.has(key)) { const nc = { ...c, character_id: `CHAR_${String(byLabel.size + 1).padStart(3, "0")}` }; byLabel.set(key, nc); merged.characters.push(nc); }
      else { const ex = byLabel.get(key); ex.key_actions = [...ex.key_actions, ...c.key_actions]; ex.traits = [...new Set([...ex.traits, ...c.traits])]; }
      idMap.set(c.character_id, byLabel.get(key).character_id);
    }
    const mapIds = arr => arr.map(id => idMap.get(id) || id);
    merged.scenes.push(...analysis.scenes.map(s => ({ ...s, start_time: s.start_time + offset, end_time: s.end_time + offset, characters: mapIds(s.characters) })));
    merged.narrative_beats.push(...analysis.narrative_beats.map(b => ({ ...b, timestamp: b.timestamp + offset, characters: mapIds(b.characters) })));
    merged.dialogue_moments.push(...analysis.dialogue_moments.map(m => ({ ...m, timestamp: m.timestamp + offset, character_id: idMap.get(m.character_id) || m.character_id })));
  }
  for (const c of merged.characters) c.relationships = c.relationships.map(r => ({ ...r }));
  // Structure + arc: take the later chunks' resolution elements when the first chunk lacks them.
  const last = parts.at(-1).analysis;
  const els = new Map(first.story_structure.map(e => [e.element, e]));
  for (const e of last.story_structure) if (e.status === "present" && els.get(e.element)?.status !== "present") els.set(e.element, e);
  merged.story_structure = [...els.values()];
  merged.emotional_arc = { stages: [...new Set(parts.flatMap(p => p.analysis.emotional_arc.stages))], summary: parts.map(p => p.analysis.emotional_arc.summary).join(" ") };
  return merged;
}
