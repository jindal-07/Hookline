// Derives Story DNA — a structural abstraction of a source video — deterministically from the
// validated screenplay analysis, normalized transcript and matching evidence. No LLM.
// It deliberately contains narrative mechanics, not the source's names, lines or specific details.
import { validate } from "../../utils/schema.js";
import { tokenize } from "../matching/text.js";

const ENGINE_STEP = {
  hook: "Open on an attention-grabbing situation",
  setup: "Establish the protagonist's everyday situation and desire",
  inciting_incident: "Introduce an event that disrupts the status quo",
  rising_action: "Build pressure through complications",
  conflict: "Put the protagonist in direct conflict with an opposing force",
  escalation: "Raise the stakes",
  turning_point: "The protagonist makes a defining choice",
  climax: "Force a decisive confrontation",
  resolution: "Resolve the central tension",
  final_reveal: "Reveal an unexpected truth",
  call_to_action: "Close with a direct call to action",
};
const ORDER = Object.keys(ENGINE_STEP);

const INTENT_FUNCTION = [
  [/inform|explain|recite|tell/i, "Convey key information"],
  [/mock|ridicul|insult|belittl|taunt/i, "Belittle someone to raise the stakes"],
  [/demand|order|command/i, "Establish a power imbalance"],
  [/defend|assert|stand|insist|refus/i, "Assert self-worth or resist"],
  [/reveal|confess|admit|disclos/i, "Reveal a hidden truth"],
  [/withhold|lie|hide|evade|deflect/i, "Withhold or conceal information"],
  [/threat|warn/i, "Threaten or warn"],
  [/plead|beg|request|ask/i, "Ask for something the speaker needs"],
  [/accus|blame|confront/i, "Confront or accuse"],
  [/comfort|reassur|support|encourag/i, "Offer comfort or support"],
  [/offer|help|give/i, "Extend help that changes the situation"],
  [/thank|grat|apolog/i, "Deliver the emotional payoff"],
  [/question|wonder|doubt/i, "Raise a question that drives curiosity"],
];

const HOOK_PATTERNS = [
  [/secret|hidden|hide|conceal/i, "Hidden secret"],
  [/discover|find|found|uncover/i, "Unexpected discovery"],
  [/humiliat|mock|insult|underdog|ridicul/i, "Underdog humiliation"],
  [/twist|reveal|truth|actually/i, "Twist or reveal promise"],
  [/question|why|mystery|curious|who|what/i, "Unanswered question"],
  [/conflict|argu|fight|confront|shout/i, "Conflict in progress"],
  [/shock|surpris|unexpected|strange|unusual/i, "Surprising situation"],
  [/transform|before|after|change/i, "Transformation tease"],
];

const POSITIVE = /joy|hope|relief|gratitude|happiness|triumph|pride|love|warmth|payoff|satisfaction|uplift|resolve/i;
const NEGATIVE = /grief|despair|sad|tragic|loss|anger|fear|regret|shame|bitter/i;
const GENERIC = /^(the |a |an )?(man|woman|boy|girl|child|old|young|elderly|older|younger|maid|servant|driver|guard|officer|police|doctor|teacher|boss|employee|customer|stranger|friend|husband|wife|mother|father|son|daughter|brother|sister|person|narrator|guest|neighbou?r)\b/i;

export class StoryDNABuilder {
  /**
   * @param {{ analysis: object, transcript: object, matchResult?: object }} input
   * @returns {{ storyDna: object, provenance: object }}
   */
  build({ analysis: S, transcript: T, matchResult = null }) {
    const roleOf = new Map(S.characters.map(c => [c.character_id, archetype(c)]));
    const names = S.characters.filter(c => c.label && !GENERIC.test(c.label)).map(c => c.label.trim());
    const anonymise = (text) => {
      let t = String(text || "");
      for (const c of S.characters) if (c.label && !GENERIC.test(c.label)) t = t.replace(new RegExp(escapeRe(c.label), "gi"), `the ${roleOf.get(c.character_id).toLowerCase()}`);
      return t.replace(/\s+/g, " ").trim();
    };

    const present = S.story_structure.filter(e => e.status === "present");
    const presentSet = new Set(present.map(e => e.element));
    const hookText = [S.hook.curiosity_mechanism, S.hook.attention_element, S.hook.initial_question].join(" ");
    const hookPattern = HOOK_PATTERNS.find(([re]) => re.test(hookText))?.[1] || "Attention-grabbing opening";

    const conflictEl = present.find(e => e.element === "conflict") || present.find(e => e.element === "inciting_incident");
    const coreConflict = abstractConflict(conflictEl?.description || S.scenes.find(s => s.conflict)?.conflict || "", anonymise);

    const storyEngine = ORDER.filter(k => presentSet.has(k)).map(k => (k === "hook" ? `Open with a ${hookPattern.toLowerCase()}` : ENGINE_STEP[k]));
    if (!storyEngine.length) storyEngine.push(...S.narrative_beats.slice(0, 6).map(b => capitalize(b.narrative_purpose || "story beat")));

    const archetypes = [...new Set(S.characters.map(c => roleOf.get(c.character_id)))];
    const emotionalArc = [...new Set((S.emotional_arc.stages || []).map(s => capitalize(s.trim())).filter(Boolean))];

    const functions = [];
    for (const m of S.dialogue_moments) {
      const f = INTENT_FUNCTION.find(([re]) => re.test(m.intent))?.[1];
      if (f && !functions.includes(f)) functions.push(f);
    }

    const dur = S.metadata.duration_seconds || T?.duration_seconds || 0;
    const beatsPerMin = dur ? (S.narrative_beats.length / dur) * 60 : 0;
    const pacing = beatsPerMin >= 5 ? "Fast" : beatsPerMin >= 2 ? "Moderate" : "Slow";

    const lastStage = emotionalArc.at(-1) || "";
    const endingType = presentSet.has("final_reveal") ? "Unexpected reveal"
      : presentSet.has("call_to_action") ? "Direct call to action"
      : presentSet.has("resolution") ? (NEGATIVE.test(lastStage) ? "Bittersweet or tragic resolution" : POSITIVE.test(lastStage) ? "Uplifting resolution" : "Clear resolution")
      : "Open ending";

    // Distinctive source material the new script must NOT reuse.
    const avoid = [
      ...names.map(n => `character name "${n}"`),
      ...(T?.repeated_phrases || []).filter(p => tokenize(p.phrase).length >= 3).slice(0, 8).map(p => `phrase "${p.phrase}"`),
      ...signatureLines(T).map(l => `line "${l}"`),
      ...S.visual_storytelling.props.filter(p => p.basis === "observed").slice(0, 4).map(p => `prop/premise detail: ${anonymise(p.detail)}`),
      `the specific premise: ${anonymise(S.hook.opening_visual)}`,
    ];

    const storyDna = {
      hook_pattern: hookPattern,
      core_conflict: coreConflict,
      story_engine: storyEngine,
      character_archetypes: archetypes,
      emotional_arc: emotionalArc,
      dialogue_functions: functions,
      pacing,
      ending_type: endingType,
      format: {
        duration_seconds: Math.round(dur),
        scene_count: S.scenes.length,
        genre: S.metadata.genre,
        tone: S.metadata.tone,
        language: T?.language && T.language !== "unknown" ? T.language : S.metadata.primary_language,
      },
      avoid,
    };
    const check = validate("storyDna", storyDna);
    if (!check.valid) throw new Error(`Story DNA failed validation: ${check.errors.join("; ")}`);
    return {
      storyDna,
      provenance: {
        builder_version: "1.0",
        source_match_score: matchResult?.overall_score ?? null,
        source_match_confidence: matchResult?.confidence ?? null,
        names_removed: names,
      },
    };
  }
}

function archetype(c) {
  const role = String(c.role || "character").replace(/\s+/g, " ").trim();
  const trait = (c.traits || [])[0];
  return capitalize(trait && !role.toLowerCase().includes(trait.toLowerCase()) ? `${role} (${trait})` : role);
}

function abstractConflict(text, anonymise) {
  const t = anonymise(text);
  if (!t) return "A protagonist faces opposition that blocks what they want";
  return capitalize(t.replace(/\.$/, ""));
}

/** The source's most distinctive spoken lines (long important statements), truncated. */
function signatureLines(T) {
  if (!T) return [];
  const all = [...(T.dialogue_segments || []), ...(T.narration_segments || [])];
  return (T.important_statements || [])
    .map(s => all.find(x => x.segment_id === s.segment_id)?.text)
    .filter(t => t && tokenize(t).length >= 4)
    .slice(0, 6)
    .map(t => (t.length > 90 ? `${t.slice(0, 87)}...` : t));
}

const capitalize = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
