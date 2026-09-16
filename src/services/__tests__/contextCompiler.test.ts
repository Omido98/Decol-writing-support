import { describe, it, expect } from "vitest";
import { compileContext, applySourcePicks } from "@/services/contextCompiler";

const base = {
  systemPrompt: "You are a writing partner.",
  history: [
    { role: "user" as const, content: "first question" },
    { role: "assistant" as const, content: "first answer" },
  ],
  instruction: "now revise the opening",
};

describe("compileContext", () => {
  it("builds the payload: system, history, then the instruction", () => {
    const compiled = compileContext(base);
    expect(compiled.messages).toEqual([
      { role: "system", content: "You are a writing partner." },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "now revise the opening" },
    ]);
    expect(compiled.tokenEstimate).toBeGreaterThan(0);
  });

  it("the manifest accounts for every entry with token estimates", () => {
    const compiled = compileContext(base);
    const kinds = compiled.manifest.map((m) => m.kind);
    expect(kinds).toEqual(["system", "history", "history", "instruction"]);
    const sum = compiled.manifest.reduce((s, m) => s + m.tokenEstimate, 0);
    expect(compiled.tokenEstimate).toBe(sum);
    expect(compiled.manifest.every((m) => m.included)).toBe(true);
  });

  it("included sources ride the system content; excluded ones are visible omissions", () => {
    const compiled = compileContext({
      ...base,
      sources: [
        { id: "s1", title: "Césaire 1950", content: "The excerpt text.", included: true },
        { id: "s2", title: "Excluded source", content: "not sent", included: false },
      ],
    });
    // Included: appended to the SYSTEM content under a clear heading.
    const system = compiled.messages[0].content;
    expect(system).toContain("## Sources the writer selected for this request");
    expect(system).toContain("### Césaire 1950");
    expect(system).toContain("The excerpt text.");
    // Excluded: in the manifest as omitted — never silent.
    const excluded = compiled.manifest.find((m) => m.id === "s2")!;
    expect(excluded.included).toBe(false);
    expect(excluded.omittedReason).toContain("your choice");
    // And the payload does NOT contain the excluded material.
    expect(system).not.toContain("not sent");
    expect(system).not.toContain("Excluded source");
  });

  it("a large manuscript is truncated with the cut reported", () => {
    const compiled = compileContext({
      ...base,
      manuscript: { title: "The Essay", plainText: "x".repeat(15_000) },
    });
    const entry = compiled.manifest.find((m) => m.kind === "manuscript")!;
    expect(entry.included).toBe(true);
    expect(entry.includedChars).toBeLessThan(15_000);
    expect(entry.omittedReason).toMatch(/first .* characters/);
  });

  it("carries model and output budget for the manifest", () => {
    const compiled = compileContext({
      ...base,
      model: "writer-9",
      outputBudget: 2048,
    });
    expect(compiled.model).toBe("writer-9");
    expect(compiled.outputBudget).toBe(2048);
  });
});

describe("per-send source picking (D4)", () => {
  const scoped = [
    { id: "s1", title: "Picked source", content: "picked material", included: false },
    { id: "s2", title: "Unpicked source", content: "unpicked material", included: true },
    { id: "s3", title: "Neutral source", content: "neutral material", included: true },
  ];

  it("a pick overrides inclusion for the send, with exact omission reasons", () => {
    const picked = applySourcePicks(scoped, ["s1"]);
    expect(picked.find((s) => s.id === "s1")!.included).toBe(true);
    const unpicked = picked.find((s) => s.id === "s2")!;
    expect(unpicked.included).toBe(false);
    expect(unpicked.omittedReason).toBe("Not picked for this send.");

    // The compiled manifest reports the override verbatim, and the
    // payload contains ONLY the picked material.
    const compiled = compileContext({
      ...base,
      sources: picked,
    });
    const system = compiled.messages[0].content;
    expect(system).toContain("picked material");
    expect(system).not.toContain("unpicked material");
    const s1Entry = compiled.manifest.find((m) => m.id === "s1")!;
    expect(s1Entry.included).toBe(true);
    const s2Entry = compiled.manifest.find((m) => m.id === "s2")!;
    expect(s2Entry.omittedReason).toBe("Not picked for this send.");
  });

  it("undefined keeps the default inclusion; an explicit empty pick sends none (B14)", () => {
    expect(applySourcePicks(scoped, undefined)).toEqual(scoped);
    const none = applySourcePicks(scoped, []);
    expect(none.every((s) => !s.included)).toBe(true);
    expect(none.every((s) => s.omittedReason === "Not picked for this send.")).toBe(
      true,
    );
  });
});
