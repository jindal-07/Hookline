// Representative transcript + screenplay fixtures — shared by the test suite and `npm run demo`.
// The story: a housemaid secretly studies for the civil-services exam; her employer mocks her;
// the employer's son gives her his old books.
import { TranscriptNormalizer } from "../services/normalization/TranscriptNormalizer.js";

const char = (character_id, label, role, motivation, relationships, key_actions) => ({
  character_id, label, appearance: "", age_range: "", role, traits: [], motivation, relationships, key_actions, emotional_progression: "",
});
const detail = (d) => ({ detail: d, basis: "observed" });

export function baseScreenplay(overrides = {}) {
  return structuredClone({
    metadata: { duration_seconds: 60, primary_language: "hi", genre: "Family drama", setting: "Middle-class home", tone: "Hopeful", visual_style: "Naturalistic", narrative_format: "scripted drama" },
    hook: { opening_visual: "A maid reads notes while cooking", first_seconds: "Meera studies secretly in the kitchen", attention_element: "Hidden notebook", curiosity_mechanism: "Why is a maid studying law?", initial_question: "Will she achieve her dream?" },
    characters: [
      char("CHAR_001", "Meera", "protagonist", "Wants to become an IAS officer", [{ character_id: "CHAR_002", relationship: "employee" }], ["studies her notes", "says she will keep trying", "thanks Rohan"]),
      char("CHAR_002", "Mrs. Kapoor", "antagonist employer", "Keeps the maid in her place", [{ character_id: "CHAR_001", relationship: "employer" }], ["demands tea", "mocks the maid's dream"]),
      char("CHAR_003", "Rohan", "ally", "Wants to help Meera study", [{ character_id: "CHAR_002", relationship: "son" }], ["gives his old books"]),
    ],
    scenes: [
      { scene_id: "SCENE_001", start_time: 0, end_time: 15, location: "Kitchen", characters: ["CHAR_001", "CHAR_002"], visual_description: "Meera studies her constitution notes while cooking", actions: ["hides notebook"], emotional_state: "Focused", conflict: "Studying in secret", narrative_purpose: "Setup", dialogue_summary: "Meera recites a constitution article; Mrs. Kapoor demands tea", story_beat: "Setup", boundary_certainty: "approximate" },
      { scene_id: "SCENE_002", start_time: 15, end_time: 40, location: "Living room", characters: ["CHAR_001", "CHAR_002"], visual_description: "Mrs. Kapoor finds the notebook and mocks Meera", actions: ["holds up notebook"], emotional_state: "Humiliation", conflict: "Employer ridicules the maid's ambition", narrative_purpose: "Conflict", dialogue_summary: "Mrs. Kapoor mocks the dream; Meera says there is nothing wrong in trying", story_beat: "Conflict", boundary_certainty: "approximate" },
      { scene_id: "SCENE_003", start_time: 40, end_time: 60, location: "Rooftop at night", characters: ["CHAR_001", "CHAR_003"], visual_description: "Rohan brings old books to Meera on the roof at night", actions: ["hands over books"], emotional_state: "Gratitude", conflict: "", narrative_purpose: "Resolution", dialogue_summary: "Rohan offers his old books; Meera thanks him", story_beat: "Resolution", boundary_certainty: "approximate" },
    ],
    story_structure: [
      { element: "hook", status: "present", description: "A maid secretly studies law notes", start_time: 0 },
      { element: "conflict", status: "present", description: "The employer mocks the maid's dream of becoming an officer", start_time: 20 },
      { element: "turning_point", status: "present", description: "Meera insists there is nothing wrong in trying", start_time: 32 },
      { element: "resolution", status: "present", description: "Rohan gives her his old books and she thanks him", start_time: 45 },
      { element: "climax", status: "uncertain", description: "" },
      { element: "call_to_action", status: "absent", description: "" },
    ],
    narrative_beats: [
      { beat_id: "B1", timestamp: 2, description: "Meera studies constitution rights notes secretly while cooking", characters: ["CHAR_001"], emotional_impact: "curiosity", narrative_purpose: "setup" },
      { beat_id: "B2", timestamp: 10, description: "Mrs. Kapoor calls Meera and demands tea", characters: ["CHAR_002"], emotional_impact: "tension", narrative_purpose: "establish hierarchy" },
      { beat_id: "B3", timestamp: 20, description: "Mrs. Kapoor mocks the maid's dream of becoming an officer", characters: ["CHAR_002", "CHAR_001"], emotional_impact: "humiliation", narrative_purpose: "conflict", cause: "B2" },
      { beat_id: "B4", timestamp: 32, description: "Meera says there is nothing wrong in trying", characters: ["CHAR_001"], emotional_impact: "resolve", narrative_purpose: "turning point", cause: "B3" },
      { beat_id: "B5", timestamp: 45, description: "Rohan gives Meera his old books on the roof at night", characters: ["CHAR_003", "CHAR_001"], emotional_impact: "hope", narrative_purpose: "resolution" },
      { beat_id: "B6", timestamp: 55, description: "Meera thanks Rohan with tears", characters: ["CHAR_001"], emotional_impact: "payoff", narrative_purpose: "emotional payoff", cause: "B5" },
    ],
    emotional_arc: { stages: ["curiosity", "humiliation", "resolve", "hope"], summary: "From secret effort through ridicule to support" },
    visual_storytelling: { camera: [detail("Handheld mid shots")], gestures: [detail("Holding up the notebook")], props: [detail("Notebook")], locations: [detail("Kitchen"), detail("Rooftop")], text_overlays: [], visual_reveals: [detail("Notebook discovered")], transitions: [detail("Cut to night")], symbolic_objects: [{ detail: "Books symbolise opportunity", basis: "interpreted" }] },
    dialogue_moments: [
      { timestamp: 3, character_id: "CHAR_001", summary: "Meera recites the constitution article about the right to life and liberty", intent: "inform", is_reveal: false },
      { timestamp: 11, character_id: "CHAR_002", summary: "Mrs. Kapoor demands to know why the tea is not ready", intent: "demand", is_reveal: false },
      { timestamp: 21, character_id: "CHAR_002", summary: "Mrs. Kapoor mocks: will the maid become an officer now? Look at this dream", intent: "mock", is_reveal: true },
      { timestamp: 33, character_id: "CHAR_001", summary: "Meera asks madam what is wrong in trying", intent: "defend", is_reveal: false },
      { timestamp: 46, character_id: "CHAR_003", summary: "Rohan offers his old books and tells her to keep them", intent: "offer", is_reveal: false },
      { timestamp: 56, character_id: "CHAR_001", summary: "Meera thanks him", intent: "thank", is_reveal: false },
    ],
    ...overrides,
  });
}

/** AssemblyAI-shaped raw transcript (ms timestamps). */
export function rawTranscript(utterances, { language = "hi", duration = 60, wordConfidence = 0.94, languageConfidence = 0.97, diarized = true } = {}) {
  const words = utterances.flatMap(u => u.text.split(/\s+/).map((w, i, arr) => ({ text: w, start: u.start + (i * (u.end - u.start)) / arr.length, end: u.start + ((i + 1) * (u.end - u.start)) / arr.length, confidence: wordConfidence, speaker: u.speaker })));
  return {
    id: "tx_test", status: "completed", language_code: language, language_confidence: languageConfidence, audio_duration: duration,
    confidence: wordConfidence, text: utterances.map(u => u.text).join(" "), words,
    utterances: diarized ? utterances.map(u => ({ ...u, confidence: wordConfidence })) : null,
    __sentences: diarized ? null : utterances.map(u => ({ text: u.text, start: u.start, end: u.end, confidence: wordConfidence, speaker: null })),
  };
}

const U = (speaker, s, e, text) => ({ speaker, start: s * 1000, end: e * 1000, text });

export const HINDI_UTTERANCES = [
  U("A", 2, 6, "अनुच्छेद इक्कीस जीवन और स्वतंत्रता का अधिकार"),
  U("B", 10, 13, "मीरा चाय अभी तक नहीं बनी"),
  U("B", 20, 25, "अब नौकरानी अफसर बनेगी यह सपना देखो"),
  U("A", 32, 36, "कोशिश करने में क्या बुराई है मैडम"),
  U("C", 45, 50, "ये मेरी पुरानी किताबें हैं तुम रख लो"),
  U("A", 55, 58, "शुक्रिया"),
];

export const HINGLISH_UTTERANCES = [
  U("A", 2, 6, "Article 21, jeevan aur swatantrata ka adhikar"),
  U("B", 10, 13, "Meera, chai abhi tak nahi bani? Jaldi"),
  U("B", 20, 25, "Ab naukrani afsar banegi? Yeh sapna dekho"),
  U("A", 32, 36, "Koshish karne mein kya burai hai madam"),
  U("C", 45, 50, "Yeh meri purani kitaben hain, rakh lo"),
  U("A", 55, 58, "Shukriya, thank you"),
];

/** Same vocabulary, different story: lines scrambled in time and given to the wrong speakers. */
export const SCRAMBLED_UTTERANCES = [
  U("C", 2, 6, "शुक्रिया मैडम"),
  U("A", 10, 13, "ये मेरी पुरानी किताबें हैं तुम रख लो"),
  U("C", 20, 25, "कोशिश करने में क्या बुराई है"),
  U("B", 32, 36, "मीरा चाय अभी तक नहीं बनी"),
  U("A", 45, 50, "अब नौकरानी अफसर बनेगी यह सपना देखो"),
  U("B", 55, 58, "अनुच्छेद इक्कीस जीवन और स्वतंत्रता का अधिकार"),
];

/** Contradictory: the speech is about something else entirely. */
export const CONTRADICTORY_UTTERANCES = [
  U("A", 2, 6, "कल का क्रिकेट मैच देखा क्या"),
  U("B", 10, 13, "बारिश हो रही है छाता ले लो"),
  U("B", 20, 25, "आज रात खाना बिरयानी बनेगा"),
  U("A", 32, 36, "मैच में बहुत बारिश थी"),
  U("C", 45, 50, "बिरयानी बहुत अच्छी है खाना खाओ"),
  U("A", 55, 58, "क्रिकेट मैच कब है"),
];

export async function normalized(utterances, opts = {}) {
  const raw = rawTranscript(utterances, opts);
  return new TranscriptNormalizer().normalize({ raw, sentences: raw.__sentences, videoId: "video_001" });
}
