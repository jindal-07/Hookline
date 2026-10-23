import { describe, it, expect } from "vitest";
import { forbiddenNameWords, namesToAvoid, repairReusedNames } from "../../server/src/services/generation/NameRepair.js";
import { ScriptGenerationService } from "../../server/src/services/generation/ScriptGenerationService.js";
import { MockSkillAdapter } from "../../server/src/services/generation/skillAdapters.js";

const SOURCE = ["Sheriff Earl Vance", "Maya", "Hope Long", "Store Manager"];
const SCRIPT = `# The Long Night

## Main Characters
- **MAYA** (30s, nurse) — tired, kind. She works nights.
- **EARL VANCE** (60s) — the sheriff. He never smiles.

## Scene 1 - INT. Diner - Night

Maya pours coffee. She glances at Earl.

EARL
Long night?

MAYA
(quietly)
Long enough, Vance.

Long before dawn, the lights flicker.
`;

describe("NameRepair", () => {
  it("lists source name words to avoid, without role words", () => {
    const words = forbiddenNameWords(SOURCE);
    expect([...words]).toEqual(expect.arrayContaining(["earl", "vance", "maya", "hope", "long"]));
    expect(words.has("sheriff")).toBe(false);
    expect(words.has("manager")).toBe(false);
    expect(namesToAvoid(SOURCE)).toContain("Vance");
  });

  it("renames reused names everywhere, by gender, keeping ordinary words", () => {
    const { content, renames } = repairReusedNames(SCRIPT, ["Sheriff Earl Vance", "Maya"], { forbidden: forbiddenNameWords(SOURCE) });
    expect(renames.map(r => r.from).sort()).toEqual(["Earl", "Maya", "Vance"]);
    expect(content).not.toMatch(/\b(Maya|MAYA|Earl|EARL|Vance|VANCE)\b/);
    const maya = renames.find(r => r.from === "Maya").to;
    const earl = renames.find(r => r.from === "Earl").to;
    expect(content).toContain(`**${maya.toUpperCase()}**`);
    expect(content).toContain(`\n${earl.toUpperCase()}\nLong night?`);
    expect(content).toContain("Long before dawn"); // ordinary words, not the surname "Long"
    expect(content).toContain("# The Long Night");
    expect(["Desmond", "Lucian", "Thaddeus", "Ambrose", "Casimir", "Dorian", "Evander", "Fitzgerald", "Gideon", "Horatio", "Ignatius", "Jasper", "Leopold", "Magnus", "Nikolai", "Octavian", "Percival", "Quentin", "Rafferty", "Silas", "Tobias", "Ulric", "Valentin", "Wendell", "Xavier", "Yorick", "Zeb", "Anselm", "Barnaby", "Cormac", "Dashiell", "Emmett", "Florian", "Griffin", "Hollis", "Isidore", "Jules", "Kasimir", "Linus", "Montague"]).toContain(earl);
    for (const r of renames) expect(forbiddenNameWords(SOURCE).has(r.to.toLowerCase())).toBe(false);
  });

  it("uses Indian names for Hindi briefs", () => {
    const { renames } = repairReusedNames("Maya smiles. She waves.", ["Maya"], { forbidden: new Set(["maya"]), language: "hi" });
    expect(["Ishita", "Mehrunnisa", "Tanvi", "Charulata", "Vaidehi", "Nandini", "Shalmali", "Ragini", "Ketaki", "Madhavi", "Sharvari", "Urmila", "Devyani", "Ambika", "Bhairavi", "Chandrika", "Damini", "Gargi", "Hemangi", "Jahnavi", "Kalindi", "Lavanya", "Mrinalini", "Nirupama", "Oorja", "Pallavi", "Rukmini", "Sanyukta", "Trishala", "Upasana", "Vasudha", "Yamini", "Zoya", "Aparna", "Bhavna"]).toContain(renames[0].to);
  });
});

describe("standalone scripts with a reused name", () => {
  it("repairs the name, passes the check and records the rename", async () => {
    const svc = new ScriptGenerationService({ adapter: new MockSkillAdapter() });
    const out = await svc.finalizeStandalone(SCRIPT, { corpus: { lines: [], names: SOURCE, overlays: [] }, language: "en" });
    expect(out.status).toBe("COMPLETED");
    expect(out.originality.passed).toBe(true);
    expect(out.metadata.renamed.length).toBe(3);
    expect(out.content).not.toMatch(/\bMaya\b/);
  });

  it("sends the names to avoid to the skill", async () => {
    let seen;
    const adapter = { identifier: "spy", invoke: async (payload) => { seen = payload; return { status: "COMPLETED", content: "# X\n\n## Scene 1 - INT. Room - Day\n\nA door opens.", metadata: {} }; } };
    await new ScriptGenerationService({ adapter }).generateStandalone({ brief: { language: "en" }, playbook: {}, corpus: { names: SOURCE }, scriptId: "t" });
    expect(seen.avoid_names).toEqual(expect.arrayContaining(["Maya", "Earl", "Vance"]));
  });
});
