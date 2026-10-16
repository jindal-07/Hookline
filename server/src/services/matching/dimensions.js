// Story, character and dialogue scoring. Every number here is derived from structured evidence
// that is also returned, so each score can be explained in the dashboard.
import { cosine, calibrate } from "../embeddings/EmbeddingService.js";
import { bestMatch, orderConcordance, weightedMean, speechNear, segmentsIn, round3 } from "./align.js";
import { tokenize } from "./text.js";

const SUPPORT = 0.5;      // calibrated agreement needed to count an element as "supported"
const CONTRADICT = 0.12;  // agreement below this, with speech present, counts as a contradiction
const KEY_ELEMENTS = ["inciting_incident", "conflict", "turning_point", "climax", "resolution", "final_reveal"];
export const IDENTITY_UNCERTAINTY_DISCOUNT = 0.85;
const NON_CHARACTERS = new Set(["UNKNOWN", "NARRATOR", "", null, undefined]);
const GENERIC_LABEL = /^(the |a |an )?(man|woman|boy|girl|child|kid|old|young|elderly|older|younger|maid|servant|driver|guard|officer|police|doctor|teacher|boss|employee|customer|stranger|friend|husband|wife|mother|father|son|daughter|brother|sister|person|narrator|speaker|character|guest|neighbour|neighbor)\b/i;

// ---------- story ----------
export function scoreStory(ctx) {
  const { S, spoken, windows, vecOf, cal } = ctx;
  const evidence = { matches: [], mismatches: [], uncertain: [] };

  const events = S.narrative_beats.length
    ? S.narrative_beats.map(b => ({ id: b.beat_id, t: b.timestamp, text: b.description, cause: b.cause || null }))
    : S.scenes.map(s => ({ id: s.scene_id, t: s.start_time, text: [s.visual_description, ...s.actions].join(". "), cause: null }));

  const evaluated = [];
  for (const e of events) {
    if (!speechNear(spoken, e.t)) {
      evidence.uncertain.push({ type: "visual_only_event", screenplay_ref: e.id, timestamp: e.t, text: e.text, note: "No speech near this event — not expected in the transcript, not scored" });
      continue;
    }
    const m = bestMatch(vecOf(e.text), windows, vecOf, cal, { around: e.t, radius: 10 });
    evaluated.push({ ...e, m });
    const item = { type: "event", screenplay_ref: e.id, timestamp: e.t, text: e.text, transcript_ref: m.window.segment_ids, transcript_text: m.window.text, transcript_time: m.window.start, similarity: round3(m.raw), agreement: round3(m.adjusted) };
    (m.adjusted >= SUPPORT ? evidence.matches : evidence.uncertain).push(m.adjusted >= SUPPORT ? item : { ...item, note: "Weak agreement with the transcript" });
  }
  const coverage = evaluated.length ? evaluated.reduce((t, e) => t + e.m.adjusted, 0) / evaluated.length : null;

  // Event order + cause→effect ordering among supported events
  const supported = evaluated.filter(e => e.m.adjusted >= SUPPORT);
  let order = orderConcordance(supported.map(e => e.m.window.start));
  const causal = supported.filter(e => e.cause).map(e => {
    const c = supported.find(x => x.id === e.cause);
    return c ? (c.m.window.start <= e.m.window.start ? 1 : 0) : null;
  }).filter(v => v !== null);
  if (causal.length) order = weightedMean([[order, 2], [causal.reduce((a, b) => a + b, 0) / causal.length, 1]]);
  if (order !== null && order < 0.5) evidence.mismatches.push({ type: "event_order", dimension: "story", note: `Spoken events appear in a different order than the screenplay (concordance ${round3(order)})` });

  // Key structural elements (conflict, turning point, outcome…) against the whole transcript
  const keys = S.story_structure.filter(e => e.status === "present" && KEY_ELEMENTS.includes(e.element) && e.description?.trim());
  const keyScores = keys.map(k => {
    const m = bestMatch(vecOf(k.description), windows, vecOf, cal, { around: typeof k.start_time === "number" ? k.start_time : null, radius: 15 });
    const item = { type: "story_element", element: k.element, text: k.description, transcript_ref: m.window.segment_ids, transcript_text: m.window.text, similarity: round3(m.raw), agreement: round3(m.adjusted) };
    if (m.adjusted >= SUPPORT) evidence.matches.push(item); else evidence.uncertain.push({ ...item, note: "Element not clearly reflected in speech" });
    return m.adjusted;
  });
  const key = keyScores.length ? keyScores.reduce((a, b) => a + b, 0) / keyScores.length : null;

  // Contradiction: a scene the screenplay says is silent contains substantial speech
  const unaccounted = [];
  for (const s of S.scenes) {
    if (s.dialogue_summary?.trim()) continue;
    const inScene = segmentsIn(spoken, s.start_time, s.end_time);
    const words = inScene.reduce((t, x) => t + tokenize(x.text).length, 0);
    if (words >= 15) unaccounted.push({ type: "unaccounted_speech", dimension: "story", screenplay_ref: s.scene_id, transcript_ref: inScene.map(x => x.segment_id), note: `Screenplay describes ${s.scene_id} without dialogue, but the transcript has ${words} words there` });
  }
  evidence.mismatches.push(...unaccounted);

  const score = weightedMean([[coverage, 0.5], [order, 0.25], [key, 0.25]]);
  return {
    score: score === null ? null : score * 100,
    components: { coverage: round3(coverage), order: round3(order), key_elements: round3(key) },
    counts: { events: events.length, evaluable: evaluated.length, supported: supported.length, key_elements: keys.length },
    contradictions: unaccounted.length + (order !== null && order < 0.5 ? 1 : 0),
    evidence,
  };
}

// ---------- characters ----------
export function scoreCharacters(ctx, mapping) {
  const { S, T, spoken, vecOf, cal } = ctx;
  const evidence = { matches: [], mismatches: [], uncertain: [] };
  const speakers = [...new Set(spoken.map(s => s.speaker_id))].filter(s => s !== "SPEAKER_UNKNOWN");
  const charsWithLines = [...new Set(S.dialogue_moments.map(m => m.character_id))].filter(c => !NON_CHARACTERS.has(c));
  const byId = Object.fromEntries(S.characters.map(c => [c.character_id, c]));

  // Speaker → character consistency (only when diarization gives us identities)
  let consistency = null;
  if (mapping.evaluable) {
    let ok = 0, n = 0;
    for (const v of mapping.observations) {
      if (NON_CHARACTERS.has(v.character_id)) continue;
      const assigned = mapping.assignment[v.speaker_id];
      if (!assigned) continue;
      n++;
      if (assigned === v.character_id) ok++;
      else if (mapping.confidence[v.speaker_id] >= 0.7) {
        evidence.mismatches.push({ type: "speaker_conflict", dimension: "character", timestamp: v.timestamp, note: `Screenplay attributes the line at ${v.timestamp}s to ${byId[v.character_id]?.label || v.character_id}, but ${v.speaker_id} is mapped to ${byId[assigned]?.label || assigned}` });
      }
    }
    consistency = n ? ok / n : null;
    for (const [spk, ch] of Object.entries(mapping.assignment))
      evidence.matches.push({ type: "speaker_mapping", speaker_id: spk, character_id: ch, label: byId[ch]?.label, mapping_confidence: round3(mapping.confidence[spk]), votes: round3(mapping.votes[spk]?.[ch] || 0) });
    for (const spk of speakers.filter(s => !mapping.assignment[s]))
      evidence.uncertain.push({ type: "unmapped_speaker", speaker_id: spk, note: "Speaker could not be tied to a screenplay character" });
  } else {
    evidence.uncertain.push({ type: "speaker_identity", note: mapping.reason || "Transcript speakers cannot be reliably identified — speaker-to-character mapping not scored" });
  }

  // Role / motivation alignment: character profile vs what that character (or everyone, if unmapped) says
  const profileText = c => [`${c.label}: ${c.role}.`, c.motivation, c.key_actions.slice(0, 4).join("; "), c.relationships.map(r => `${r.relationship} of ${byId[r.character_id]?.label || r.character_id}`).join("; ")].filter(Boolean).join(" ");
  const roleScores = [];
  const targets = mapping.evaluable && Object.keys(mapping.assignment).length
    ? Object.entries(mapping.assignment).map(([spk, ch]) => ({ ch, text: spoken.filter(s => s.speaker_id === spk).map(s => s.text).join(" ").slice(0, 2000) }))
    : charsWithLines.map(ch => ({ ch, text: spoken.map(s => s.text).join(" ").slice(0, 2000) }));
  for (const { ch, text } of targets) {
    const c = byId[ch];
    if (!c || !text) continue;
    const agreement = calibrate(cosine(vecOf(profileText(c)), vecOf(text)), cal);
    roleScores.push(agreement);
    const item = { type: "role_alignment", character_id: ch, label: c.label, role: c.role, agreement: round3(agreement) };
    (agreement >= SUPPORT ? evidence.matches : evidence.uncertain).push(agreement >= SUPPORT ? item : { ...item, note: "Spoken content only weakly reflects this character's role" });
  }
  // Role alignment is a soft signal (profiles describe, dialogue enacts), so it's scaled up and capped.
  const role = roleScores.length ? Math.min(1, (roleScores.reduce((a, b) => a + b, 0) / roleScores.length) * 1.25) : null;

  // Speaker count plausibility
  let count = null;
  if (mapping.evaluable && speakers.length && charsWithLines.length) {
    count = Math.min(speakers.length, charsWithLines.length) / Math.max(speakers.length, charsWithLines.length);
    if (count < 0.5) evidence.uncertain.push({ type: "speaker_count", note: `${speakers.length} transcript speakers vs ${charsWithLines.length} speaking characters` });
  }

  // Named characters referenced in dialogue (same-script names only; transliteration is not attempted)
  let refs = null;
  const named = S.characters.filter(c => c.label && !GENERIC_LABEL.test(c.label) && /^(\p{Lu}|\p{Script=Devanagari})/u.test(c.label));
  if (named.length) {
    const textTokens = new Set(tokenize(spoken.map(s => s.text).join(" ")));
    const comparable = named.filter(c => /[ऀ-ॿ]/.test(c.label) === /[ऀ-ॿ]/.test([...textTokens].join(" ")));
    if (comparable.length) {
      const hits = comparable.filter(c => tokenize(c.label).some(t => t.length > 2 && textTokens.has(t)));
      refs = hits.length / comparable.length;
      for (const c of hits) evidence.matches.push({ type: "name_reference", character_id: c.character_id, label: c.label });
    }
  }

  let score = weightedMean([[consistency, 0.45], [role, 0.25], [count, 0.2], [refs, 0.1]]);
  // Without speaker identities the score rests on soft role evidence only → explicit uncertainty discount.
  const identityDiscount = mapping.evaluable ? 1 : IDENTITY_UNCERTAINTY_DISCOUNT;
  if (score !== null) score *= identityDiscount;
  const contradictions = evidence.mismatches.length;
  return {
    score: score === null ? null : score * 100,
    components: { speaker_consistency: round3(consistency), role_alignment: round3(role), speaker_count: round3(count), name_references: round3(refs), identity_discount: identityDiscount },
    counts: { speakers: speakers.length, speaking_characters: charsWithLines.length, mapped: Object.keys(mapping.assignment || {}).length },
    contradictions,
    evidence,
    diarized: !!T.diarized,
  };
}

/** Vote-based speaker→character mapping from timestamp overlap + semantic agreement of each line. */
export function mapSpeakers(ctx) {
  const { S, T, spoken, vecOf, cal } = ctx;
  const speakers = [...new Set(spoken.map(s => s.speaker_id))];
  if (!T.diarized || !speakers.length || (speakers.length === 1 && speakers[0] === "SPEAKER_UNKNOWN"))
    return { evaluable: false, reason: "Transcript has no speaker diarization", assignment: {}, confidence: {}, votes: {}, observations: [] };
  if (!S.dialogue_moments.length)
    return { evaluable: false, reason: "Screenplay has no attributed dialogue moments", assignment: {}, confidence: {}, votes: {}, observations: [] };

  const votes = {};
  const observations = [];
  for (const m of S.dialogue_moments) {
    const seg = spoken.find(s => s.start_time - 1.5 <= m.timestamp && s.end_time + 1.5 >= m.timestamp)
      || spoken.filter(s => Math.abs(s.start_time - m.timestamp) <= 3).sort((a, b) => Math.abs(a.start_time - m.timestamp) - Math.abs(b.start_time - m.timestamp))[0];
    if (!seg || seg.speaker_id === "SPEAKER_UNKNOWN") continue;
    observations.push({ speaker_id: seg.speaker_id, character_id: m.character_id, timestamp: m.timestamp, segment_id: seg.segment_id });
    if (NON_CHARACTERS.has(m.character_id)) continue;
    const w = 1 + calibrate(cosine(vecOf(m.summary), vecOf(seg.text)), cal);
    votes[seg.speaker_id] ??= {};
    votes[seg.speaker_id][m.character_id] = (votes[seg.speaker_id][m.character_id] || 0) + w;
  }
  const pairs = Object.entries(votes).flatMap(([spk, chars]) => Object.entries(chars).map(([ch, v]) => ({ spk, ch, v })))
    .sort((a, b) => b.v - a.v || a.spk.localeCompare(b.spk) || a.ch.localeCompare(b.ch));
  const assignment = {}, usedChars = new Set(), confidence = {};
  for (const { spk, ch } of pairs) {
    if (assignment[spk] || usedChars.has(ch)) continue;
    assignment[spk] = ch; usedChars.add(ch);
  }
  for (const [spk, ch] of Object.entries(assignment)) {
    const total = Object.values(votes[spk]).reduce((a, b) => a + b, 0);
    confidence[spk] = total ? votes[spk][ch] / total : 0;
  }
  return { evaluable: observations.length > 0, reason: observations.length ? null : "No dialogue moments overlap transcript speech", assignment, confidence, votes, observations };
}

// ---------- dialogue ----------
export function scoreDialogue(ctx) {
  const { S, T, spoken, windows, vecOf, cal, allVecs } = ctx;
  const evidence = { matches: [], mismatches: [], uncertain: [] };

  let moments = S.dialogue_moments.map((m, i) => ({ id: `DM_${i + 1}`, t: m.timestamp, text: m.summary, intent: m.intent, reveal: m.is_reveal, character_id: m.character_id }));
  if (!moments.length) // fall back to scene-level dialogue summaries
    moments = S.scenes.filter(s => s.dialogue_summary?.trim()).map(s => ({ id: s.scene_id, t: s.start_time, text: s.dialogue_summary, intent: "", reveal: false }));
  if (!moments.length) return { score: null, components: {}, counts: { moments: 0 }, contradictions: 0, evidence, reason: "Screenplay contains no dialogue" };

  const scored = [];
  let contradictions = 0;
  for (const m of moments) {
    const near = speechNear(spoken, m.t, 4, 4);
    const best = bestMatch(vecOf(m.text), windows, vecOf, cal, { around: m.t, radius: 8 });
    const weight = m.reveal ? 1.5 : 1;
    const item = { type: "dialogue_moment", screenplay_ref: m.id, timestamp: m.t, intent: m.intent, is_reveal: !!m.reveal, text: m.text, transcript_ref: best.window.segment_ids, transcript_text: best.window.text, transcript_time: best.window.start, similarity: round3(best.raw), agreement: round3(best.adjusted) };
    if (!near && best.adjusted < SUPPORT) {
      contradictions++;
      evidence.mismatches.push({ ...item, type: "dialogue_without_speech", dimension: "dialogue", note: `Screenplay places dialogue at ${m.t}s but the transcript has no speech there` });
    } else if (near && best.calibrated < CONTRADICT) {
      contradictions++;
      evidence.mismatches.push({ ...item, type: "dialogue_contradiction", dimension: "dialogue", note: "Spoken content at this point does not match the screenplay's account of the dialogue" });
    } else if (best.adjusted >= SUPPORT) {
      evidence.matches.push(item);
    } else {
      evidence.uncertain.push({ ...item, note: "Partial agreement" });
    }
    scored.push({ m, best, weight });
  }
  const totalW = scored.reduce((t, s) => t + s.weight, 0);
  const meaning = scored.reduce((t, s) => t + s.best.adjusted * s.weight, 0) / totalW;
  const supported = scored.filter(s => s.best.adjusted >= SUPPORT);
  const sequence = orderConcordance(supported.map(s => s.best.window.start));
  if (sequence !== null && sequence < 0.5) { contradictions++; evidence.mismatches.push({ type: "dialogue_order", dimension: "dialogue", note: `Dialogue appears in a different order (concordance ${round3(sequence)})` }); }

  // Reverse direction: is what's actually said (important statements) reflected in the screenplay?
  const screenplayDialogueVecs = [...moments.map(m => m.text), ...S.scenes.map(s => s.dialogue_summary).filter(Boolean)].map(vecOf);
  const important = (T.important_statements || []).map(x => spoken.find(s => s.segment_id === x.segment_id)).filter(Boolean);
  const reverseScores = important.map(seg => {
    const v = vecOf(seg.text);
    const best = Math.max(0, ...screenplayDialogueVecs.map(sv => calibrate(cosine(v, sv), cal)));
    if (best < SUPPORT) evidence.uncertain.push({ type: "unreflected_statement", transcript_ref: [seg.segment_id], transcript_text: seg.text, agreement: round3(best), note: "Statement not reflected in the screenplay's dialogue summaries" });
    return best;
  });
  const reverse = reverseScores.length ? reverseScores.reduce((a, b) => a + b, 0) / reverseScores.length : null;

  // Language conflict (explicit, not inferred from wording)
  const sl = S.metadata.primary_language?.toLowerCase();
  const tl = T.language?.toLowerCase();
  if (sl && tl && sl !== "unknown" && tl !== "unknown" && sl.slice(0, 2) !== tl.slice(0, 2) && !ctx.codeSwitching) {
    evidence.uncertain.push({ type: "language_difference", note: `Screenplay reports ${sl}, transcript detected ${tl}` });
  }

  void allVecs;
  const score = weightedMean([[meaning, 0.55], [sequence, 0.2], [reverse, 0.25]]);
  return {
    score: score === null ? null : score * 100,
    components: { meaning: round3(meaning), sequence: round3(sequence), reverse_coverage: round3(reverse) },
    counts: { moments: moments.length, supported: supported.length, with_speech_nearby: moments.filter(m => speechNear(spoken, m.t, 4, 4)).length, important_statements: important.length },
    contradictions,
    evidence,
  };
}
