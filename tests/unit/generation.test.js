import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { StoryDNABuilder } from "../../server/src/services/generation/StoryDNABuilder.js";
import { OriginalityValidator } from "../../server/src/services/generation/OriginalityValidator.js";
import { ScriptGenerationService, summarizeTranscript } from "../../server/src/services/generation/ScriptGenerationService.js";
import { AgentSdkSkillAdapter, ManualSkillAdapter, DisabledSkillAdapter, MockSkillAdapter, inspectSkill } from "../../server/src/services/generation/skillAdapters.js";
import { validate } from "../../server/src/utils/schema.js";
import { baseScreenplay, normalized, HINDI_UTTERANCES } from "../fixtures/matching.js";

const tmp = path.resolve("tests/.tmp/generation");
let transcript, analysis, dna;
beforeAll(async () => {
  transcript = await normalized(HINDI_UTTERANCES);
  analysis = baseScreenplay();
  dna = new StoryDNABuilder().build({ analysis, transcript, matchResult: { overall_score: 90, confidence: 0.85 } }).storyDna;
});

describe("StoryDNABuilder", () => {
  it("produces a schema-valid structural abstraction", () => {
    expect(validate("storyDna", dna).valid).toBe(true);
    expect(dna.story_engine[0]).toMatch(/^Open with a/);
    expect(dna.story_engine).toContain("Put the protagonist in direct conflict with an opposing force");
    expect(dna.emotional_arc).toEqual(["Curiosity", "Humiliation", "Resolve", "Hope"]);
    expect(dna.dialogue_functions).toEqual(expect.arrayContaining(["Belittle someone to raise the stakes", "Establish a power imbalance", "Extend help that changes the situation"]));
    expect(dna.ending_type).toBe("Uplifting resolution");
    expect(dna.format).toMatchObject({ scene_count: 3, language: "hi", duration_seconds: 60 });
  });

  it("removes source names from the abstraction and lists distinctive material to avoid", () => {
    const { avoid, ...mechanics } = dna;
    const text = JSON.stringify(mechanics);
    for (const name of ["Meera", "Kapoor", "Rohan"]) expect(text).not.toContain(name);
    expect(avoid).toEqual(expect.arrayContaining(['character name "Meera"', 'character name "Rohan"']));
    expect(avoid.some(a => a.startsWith("line "))).toBe(true);
  });
});

describe("OriginalityValidator", () => {
  const v = new OriginalityValidator();
  const original = "INT. BUS DEPOT - NIGHT\nA ticket checker sketches bridges on ticket rolls while the depot sleeps. Her supervisor finds the drawings and reads them aloud, laughing.\nEXT. YARD - DAWN\nA retired engineer quietly hands her a drafting compass. She grips it and walks toward the night school.";

  it("passes an original script", async () => {
    const r = await v.validate(original, { transcript, analysis, storyDna: dna });
    expect(r.passed).toBe(true);
    expect(r.metrics.five_gram_overlap).toBe(0);
  });

  it("rejects scripts that copy source dialogue or reuse names", async () => {
    const copied = original + "\nMRS. SHARMA: अब नौकरानी अफसर बनेगी यह सपना देखो कोशिश करने में क्या बुराई है";
    const r = await v.validate(copied, { transcript, analysis, storyDna: dna });
    expect(r.passed).toBe(false);
    expect(r.issues.map(i => i.code)).toEqual(expect.arrayContaining(["HIGH_OVERLAP", "SIGNATURE_LINE"]));
    expect(r.issues.map(i => i.code)).not.toContain("REUSED_NAMES"); // honorific "Mrs." alone is not a reused name
    const longCopy = await v.validate(original + "\nX: अनुच्छेद इक्कीस जीवन और स्वतंत्रता का अधिकार है अब नौकरानी", { transcript, analysis, storyDna: dna });
    expect(longCopy.passed).toBe(false);
    const named = await v.validate(original + "\nMeera smiles at Rohan.", { transcript, analysis, storyDna: dna });
    expect(named.issues.map(i => i.code)).toContain("REUSED_NAMES");
  });

  it("treats role labels and ordinary words as non-names, but catches real names used as names", async () => {
    const roles = { ...analysis, characters: ["Manager", "Dad", "HR Manager", "The Chief", "Sergeant Green", "Nurse Pam", "Hope Long", "Manager (Mr. Johnson)"].map((label, i) => ({ ...analysis.characters[0], character_id: `C${i}`, label })) };
    const clean = original + "\nThe manager calls her dad. The gate light turns from green to amber. Long before dawn, nobody has much hope.";
    expect((await v.validate(clean, { analysis: roles })).issues.map(i => i.code)).not.toContain("REUSED_NAMES");
    for (const line of ["\nGREEN slams the desk.", "\nPam hands over the file.", "\nMr. Johnson nods."]) {
      const r = await v.validate(original + line, { analysis: roles });
      expect(r.issues.map(i => i.code)).toContain("REUSED_NAMES");
    }
  });

  it("rejects empty or trivially short output", async () => {
    expect((await v.validate("ok", {})).issues[0].code).toBe("TOO_SHORT");
  });
});

describe("ScriptGenerationService", () => {
  const eligible = { eligible: true, overall_score: 90 };
  const input = () => ({ storyDNA: dna, screenplayAnalysis: analysis, transcriptSummary: summarizeTranscript(transcript), transcript, matchResult: eligible, videoId: "vid-1" });

  it("refuses to generate without an approved match", async () => {
    const s = new ScriptGenerationService({ adapter: new MockSkillAdapter() });
    await expect(s.generate({ ...input(), matchResult: { eligible: false } })).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("sends Story DNA and summaries — never the raw transcript", async () => {
    const adapter = new MockSkillAdapter();
    const r = await new ScriptGenerationService({ adapter }).generate(input());
    expect(r.status).toBe("COMPLETED");
    const payload = JSON.stringify(adapter.calls[0].payload);
    expect(payload).not.toContain("नौकरानी");
    expect(adapter.calls[0].payload.story_dna.avoid.at(-1)).toMatch(/source video's dialogue/);
    expect(adapter.calls[0].payload.transcript_summary).toMatchObject({ language: "hi", speaker_count: 3 });
    expect(r.originality.passed).toBe(true);
  });

  it("marks scripts that fail originality as REJECTED", async () => {
    const adapter = new MockSkillAdapter({ output: "INT. KITCHEN\nMeera: अब नौकरानी अफसर बनेगी यह सपना देखो. Rohan gives books. ".repeat(4) });
    const r = await new ScriptGenerationService({ adapter }).generate(input());
    expect(r.status).toBe("REJECTED");
  });

  it("reports DISABLED honestly when no skill is configured", async () => {
    const r = await new ScriptGenerationService({ adapter: new DisabledSkillAdapter() }).generate(input());
    expect(r).toMatchObject({ status: "DISABLED", content: null });
  });

  it("manual mode exports a job file and waits for import", async () => {
    const adapter = new ManualSkillAdapter({ exchangeDir: tmp, skillName: "my-writer" });
    const r = await new ScriptGenerationService({ adapter }).generate(input());
    expect(r.status).toBe("AWAITING_MANUAL");
    const job = JSON.parse(readFileSync(r.metadata.exchange_file, "utf8"));
    expect(job.instructions[1]).toContain("Use the my-writer skill");
    expect(job.input.story_dna.hook_pattern).toBe(dna.hook_pattern);
  });

  it("propagates skill invocation failures", async () => {
    const err = Object.assign(new Error("boom"), { code: "SKILL_FAILED" });
    await expect(new ScriptGenerationService({ adapter: new MockSkillAdapter({ failWith: err }) }).generate(input())).rejects.toThrow("boom");
  });
});

describe("AgentSdkSkillAdapter", () => {
  const skillDir = path.join(tmp, "skill-src", "original-writer");
  const workspaceDir = path.join(tmp, "workspace");
  beforeAll(() => {
    rmSync(path.join(tmp, "skill-src"), { recursive: true, force: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: original-writer\ndescription: Writes original scripts\nversion: 2.1\n---\n# Method\nUse your own method.\n");
  });

  it("inspects the skill and copies it into an isolated workspace", async () => {
    const info = await inspectSkill(skillDir);
    expect(info).toMatchObject({ name: "original-writer", declaredVersion: "2.1" });
    const a = new AgentSdkSkillAdapter({ skillDir, workspaceDir, queryImpl: async function* () {} });
    expect(await a.describe()).toMatchObject({ mode: "agent-sdk", ready: true, skill: "original-writer", version: "2.1" });
    expect(existsSync(path.join(workspaceDir, ".claude", "skills", "original-writer", "SKILL.md"))).toBe(true);
  });

  it("invokes the skill with restricted tools and returns the result text", async () => {
    let seen;
    const queryImpl = async function* ({ prompt, options }) {
      seen = { prompt, options };
      yield { type: "system", subtype: "init", skills: ["original-writer"], model: "claude-opus-5-5" };
      yield { type: "result", subtype: "success", is_error: false, result: "INT. NEW SCRIPT\n...", num_turns: 3, total_cost_usd: 0.12 };
    };
    const r = await new AgentSdkSkillAdapter({ skillDir, workspaceDir, queryImpl, apiKey: "test" }).invoke({ story_dna: dna });
    expect(r).toMatchObject({ status: "COMPLETED", content: "INT. NEW SCRIPT\n...", metadata: { skill_version: "2.1", total_cost_usd: 0.12 } });
    expect(seen.prompt.startsWith('Use the "original-writer" skill')).toBe(true); // by name: skills may not be user-invocable
    expect(seen.options).toMatchObject({ settingSources: ["project"], skills: ["original-writer"], permissionMode: "dontAsk", cwd: workspaceDir });
    expect(seen.options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "WebFetch"]));
  });

  it("reports failures instead of pretending the skill ran", async () => {
    const failing = async function* () { yield { type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many turns"] }; };
    await expect(new AgentSdkSkillAdapter({ skillDir, workspaceDir, queryImpl: failing }).invoke({})).rejects.toMatchObject({ code: "SKILL_LIMIT" });
    const notLoaded = async function* () { yield { type: "system", subtype: "init", skills: [] }; yield { type: "result", subtype: "success", result: "x" }; };
    await expect(new AgentSdkSkillAdapter({ skillDir, workspaceDir, queryImpl: notLoaded }).invoke({})).rejects.toMatchObject({ code: "SKILL_NOT_LOADED" });
    await expect(new AgentSdkSkillAdapter({ skillDir: path.join(tmp, "missing"), workspaceDir }).invoke({})).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });
});
