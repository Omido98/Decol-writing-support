// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  buildModelGroups,
  parseSelection,
  selectionValue,
  CUSTOM_MODEL,
} from "@/components/settings/ModelPicker";
import type { CredentialProfile } from "@/utils/profiles";
import { profileAccount } from "@/utils/profiles";
import type { ZenPricingEntry } from "@/utils/api";

const profile = (
  id: string,
  name: string,
  provider: CredentialProfile["provider"],
  baseUrl: string,
): CredentialProfile => ({
  id,
  name,
  provider,
  baseUrl,
  account: profileAccount(id),
  lastUsedAt: 0,
});

const PERSONAL = profile("p1", "Personal", "zen", "https://opencode.ai/zen/v1");
const WORK = profile("p2", "Work", "zen", "https://opencode.ai/zen/v1");
const OPENAI = profile("p3", "Uni", "openai", "https://api.openai.com/v1");

describe("selection values", () => {
  it("round-trips a (profile, model) pair", () => {
    const value = selectionValue(PERSONAL.id, "some-model");
    expect(parseSelection(value)).toEqual({
      profileId: "p1",
      model: "some-model",
    });
  });

  it("keeps the same model id distinct per profile", () => {
    // The whole point of the union list: two accounts, one model id.
    expect(selectionValue(PERSONAL.id, "m")).not.toBe(
      selectionValue(WORK.id, "m"),
    );
  });

  it("does not mistake the sentinels for a pair", () => {
    expect(parseSelection("")).toBeNull();
    expect(parseSelection(CUSTOM_MODEL)).toBeNull();
  });

  it("keeps a model id that contains a separator intact", () => {
    // Only the FIRST "::" separates; a profile id is a uuid, so this is
    // unambiguous.
    expect(parseSelection(selectionValue("p1", "vendor::model"))).toEqual({
      profileId: "p1",
      model: "vendor::model",
    });
  });
});

describe("buildModelGroups", () => {
  it("gives the same model id on two profiles its own row in each", () => {
    const groups = buildModelGroups(
      [PERSONAL, WORK],
      { p1: ["m", "other"], p2: ["m"] },
      [],
      "",
      new Set(),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].models).toEqual(["m", "other"]);
    expect(groups[1].models).toEqual(["m"]);
    // Both rows are addressable, and neither shadows the other.
    const values = groups.flatMap((g) =>
      g.models.map((m) => selectionValue(g.profile.id, m)),
    );
    expect(new Set(values).size).toBe(values.length);
  });

  it("returns one group per profile, in profile order, even when empty", () => {
    const groups = buildModelGroups([PERSONAL, WORK, OPENAI], {}, [], "", new Set());
    expect(groups.map((g) => g.profile.id)).toEqual(["p1", "p2", "p3"]);
    expect(groups.every((g) => g.models.length === 0)).toBe(true);
  });

  it("pins the current selection into ITS OWN group only", () => {
    const groups = buildModelGroups(
      [PERSONAL, WORK],
      { p1: ["m"], p2: ["m"] },
      [],
      selectionValue(WORK.id, "pinned-model"),
      new Set(),
    );
    expect(groups[0].models).toEqual(["m"]); // Personal is untouched
    expect(groups[1].models).toEqual(["pinned-model", "m"]);
  });

  it("orders Zen rows free-first and sinks removed ones", () => {
    // The pricing snapshot is the evidence for what Zen still documents:
    // `gone-model-xyz` is advertised by /models but documented nowhere.
    const pricing: ZenPricingEntry[] = [
      { id: "deepseek-v4-pro", name: "DeepSeek V4", is_free: false, input: 1, output: 2 },
      { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash", is_free: true, input: 0, output: 0 },
    ];
    const groups = buildModelGroups(
      [PERSONAL],
      { p1: ["deepseek-v4-pro", "deepseek-v4-flash-free", "gone-model-xyz"] },
      pricing,
      "",
      new Set(),
    );
    const models = groups[0].models;
    expect(models[0]).toBe("deepseek-v4-flash-free");
    expect(models[models.length - 1]).toBe("gone-model-xyz");
    expect(groups[0].removed.has("gone-model-xyz")).toBe(true);
    expect(groups[0].removed.has("deepseek-v4-pro")).toBe(false);
  });

  it("flags nothing as removed without evidence", () => {
    const groups = buildModelGroups([PERSONAL], { p1: ["a", "b"] }, [], "", new Set());
    expect(groups[0].removed.size).toBe(0);
  });

  it("carries no price badges for a provider without Zen pricing", () => {
    const groups = buildModelGroups(
      [OPENAI],
      { p3: ["gpt-5"] },
      [],
      "",
      new Set(["gpt-5"]),
    );
    expect(groups[0].priced).toBe(false);
    // A free flag from the Zen table never leaks onto another provider.
    expect(groups[0].models).toEqual(["gpt-5"]);
  });
});
