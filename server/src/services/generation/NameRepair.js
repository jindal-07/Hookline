// Fixes the one originality failure that doesn't need a rewrite: a character name that also belongs to a character
// in the source videos. Each reused name is replaced throughout the script (cues, action, references, beat sheet)
// with a fresh name of the same kind (first name / surname), matching gender (from nearby pronouns) and language.
// Deterministic, no API calls. Also provides the list of source names the skill is told to avoid.
import { nameMatches, nameWords } from "./OriginalityValidator.js";

const POOLS = {
  en: {
    female: ["Tessa", "Marisol", "Ingrid", "Delphine", "Rosalind", "Odette", "Priya", "Lucinda", "Wren", "Sabine", "Celeste", "Imogen", "Paloma", "Greer", "Annika", "Bettina", "Calliope", "Daria", "Esme", "Fenella", "Giselle", "Hollis", "Isadora", "Juno", "Kerensa", "Linnea", "Maren", "Noemi", "Oriel", "Petra", "Rosamund", "Saskia", "Thea", "Undine", "Verity", "Winona", "Yolanda", "Zelda", "Amara", "Beatrix"],
    male: ["Desmond", "Lucian", "Thaddeus", "Ambrose", "Casimir", "Dorian", "Evander", "Fitzgerald", "Gideon", "Horatio", "Ignatius", "Jasper", "Leopold", "Magnus", "Nikolai", "Octavian", "Percival", "Quentin", "Rafferty", "Silas", "Tobias", "Ulric", "Valentin", "Wendell", "Xavier", "Yorick", "Zeb", "Anselm", "Barnaby", "Cormac", "Dashiell", "Emmett", "Florian", "Griffin", "Hollis", "Isidore", "Jules", "Kasimir", "Linus", "Montague"],
    neutral: ["Rowan", "Sasha", "Remy", "Ellis", "Quinn", "Arden", "Marlowe", "Sutton", "Emery", "Blair", "Hollis", "Lennox", "Oakley", "Peyton", "Reese"],
    surname: ["Ashdown", "Bellweather", "Calloway", "Delacroix", "Ellingham", "Fairbanks", "Galloway", "Hartigan", "Iverson", "Jessop", "Kestrel", "Lindqvist", "Marchetti", "Northcott", "Okonkwo", "Pemberton", "Quillfeather", "Rourke", "Sandoval", "Thornbury", "Underhill", "Valcourt", "Whitlock", "Yardley", "Zielinski", "Abernathy", "Blackwood", "Castellano", "Dunmore", "Everly", "Faraday", "Grimshaw", "Holloway", "Ingleby", "Jaramillo", "Kowalczyk", "Lockridge", "Montrose", "Nakamura", "Ostrander"],
  },
  hi: {
    female: ["Ishita", "Mehrunnisa", "Tanvi", "Charulata", "Vaidehi", "Nandini", "Shalmali", "Ragini", "Ketaki", "Madhavi", "Sharvari", "Urmila", "Devyani", "Ambika", "Bhairavi", "Chandrika", "Damini", "Gargi", "Hemangi", "Jahnavi", "Kalindi", "Lavanya", "Mrinalini", "Nirupama", "Oorja", "Pallavi", "Rukmini", "Sanyukta", "Trishala", "Upasana", "Vasudha", "Yamini", "Zoya", "Aparna", "Bhavna"],
    male: ["Advait", "Ranveer", "Tejas", "Vikrant", "Ishaan", "Kabir", "Nakul", "Parth", "Sarthak", "Utkarsh", "Yuvraj", "Anirudh", "Bhaskar", "Chiranjeev", "Devavrat", "Gaurang", "Harshvardhan", "Jaideep", "Kartikeya", "Lakshman", "Manohar", "Nishant", "Omkar", "Pranay", "Raghav", "Shaurya", "Trilok", "Uday", "Vedant", "Yashvardhan", "Abhimanyu", "Balraj", "Chetan", "Dhruv", "Eklavya"],
    neutral: ["Kiran", "Shashi", "Sumit", "Jyoti", "Noor", "Sagar", "Ravi", "Anmol"],
    surname: ["Bhattacharya", "Chaturvedi", "Deshpande", "Gokhale", "Iyengar", "Jhaveri", "Kulkarni", "Lokhande", "Malhotra", "Nadkarni", "Oberoi", "Pandit", "Raghunathan", "Sabharwal", "Thakkar", "Upadhyay", "Venkatesan", "Wadhwa", "Yadav", "Zaveri", "Ahluwalia", "Bhandari", "Chandrasekhar", "Dhillon", "Grewal", "Hegde", "Kapadia", "Mehrotra", "Purohit", "Saxena"],
  },
};

const LATIN = /^[A-Za-z][A-Za-z'’-]*$/;
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cap = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase();
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Lower-cased proper-name words of the source characters (role labels like "Manager" excluded). */
export function forbiddenNameWords(labels) {
  const out = new Set();
  for (const l of labels || []) for (const w of nameWords(l)) out.add(w.toLowerCase());
  return out;
}

/** Names the skill should not use: one entry per proper-name word, title-cased, capped for prompt size. */
export function namesToAvoid(labels, limit = 1500) {
  return [...forbiddenNameWords(labels)].filter(w => LATIN.test(w) || w.length > 1).slice(0, limit).map(w => (LATIN.test(w) ? cap(w) : w));
}

const SHE = /\b(she|her|hers|herself|woman|girl|mother|wife|daughter|sister)\b/gi;
const HE = /\b(he|him|his|himself|man|boy|father|husband|son|brother)\b/gi;
const lean = (s) => (s.match(SHE) || []).length - (s.match(HE) || []).length;

/** Gender from the character's reference entry ("- **MAYA** (30s) — … She …"), else from sentences naming them. */
function genderOf(text, word) {
  const ref = text.match(new RegExp(`^\\s*[-*]\\s*\\*\\*[^*\\n]*\\b${escapeRe(word)}\\b[^\\n]*`, "im"));
  let score = ref ? lean(ref[0]) : 0;
  if (!score) {
    const re = new RegExp(`[^.!?\\n]*\\b${escapeRe(word)}\\b[^.!?\\n]*[.!?]?[^.!?\\n]*[.!?]?`, "gi"); // the sentence with the name + the next
    for (const m of text.matchAll(re)) score += lean(m[0]);
  }
  return score > 0 ? "female" : score < 0 ? "male" : "neutral";
}

/**
 * Replace each reused source name in `content`.
 * @param {string} content
 * @param {string[]} reusedLabels  source labels flagged by the originality check (e.g. "Sheriff Earl Vance")
 * @param {{ forbidden: Set<string>, language?: string }} opts
 * @returns {{ content: string, renames: { from: string, to: string }[] }}
 */
export function repairReusedNames(content, reusedLabels, { forbidden, language = "en" } = {}) {
  const pools = POOLS[String(language).toLowerCase().startsWith("hi") ? "hi" : "en"];
  const inScript = new Set((content.match(/[\p{L}'’-]+/gu) || []).map(w => w.toLowerCase()));
  const taken = new Set([...forbidden, ...inScript]);
  const renames = [];
  let text = content;

  for (const label of reusedLabels) {
    const words = nameWords(label).filter(w => LATIN.test(w));
    words.forEach((w, idx) => {
      const capW = cap(w), upW = w.toUpperCase();
      if (!nameMatches(text, w, { multiWord: words.length > 1 }).length || renames.some(r => r.from === capW)) return;
      const role = words.length > 1 && idx === words.length - 1 ? "surname" : "first";
      const pool = role === "surname" ? pools.surname : pools[genderOf(text, capW)];
      const start = hash(capW) % pool.length;
      let fresh = null;
      for (let k = 0; k < pool.length && !fresh; k++) { const cand = pool[(start + k) % pool.length]; if (!taken.has(cand.toLowerCase())) fresh = cand; }
      if (!fresh) return; // pool exhausted: leave it for a rewrite
      taken.add(fresh.toLowerCase());
      // Replace exactly the uses the originality check counts as names (ALL CAPS stays ALL CAPS), back to front.
      for (const m of nameMatches(text, w, { multiWord: words.length > 1 }).reverse()) {
        const to = m.text === upW && m.text !== capW ? fresh.toUpperCase() : fresh;
        text = text.slice(0, m.index) + to + text.slice(m.index + m.text.length);
      }
      renames.push({ from: capW, to: fresh, label });
    });
  }
  return { content: text, renames };
}
