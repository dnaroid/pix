import { describe, expect, it } from "vitest";
import { clampThinking, modelUsage, promoteFrontier, replaceModel, upgradeCandidate, type SetupDraft, type UsageSlot } from "./model-setup-replace";

const slots: UsageSlot[] = [
  { id: "default", label: "Default model", role: "main", thinking: true },
  { id: "default-fallback", label: "Default model fallback", role: "main", optional: true, list: true, parent: "default" },
  { id: "tier-expert", label: "Routing tier: expert", role: "strong", thinking: true },
  { id: "autocomplete", label: "Autocomplete", role: "fast" },
  { id: "lookup", label: "Lookup (vision) model", role: "fast", optional: true },
  { id: "frontier-primary", label: "Frontier model (primary)", role: "strong" },
  { id: "frontier-extra", label: "More frontier models", role: "strong", optional: true, list: true, parent: "frontier-primary" },
];

const draft: SetupDraft = {
  roles: { main: "p/sonnet-4", fast: "p/haiku-4", strong: "p/opus-4" },
  picks: { lookup: "p/haiku-4" },
  lists: { "default-fallback": ["p/opus-4", "q/x"], "frontier-extra": ["q/x"] },
  thinking: { default: "medium", "tier-expert": "max" },
};

describe("model setup replace", () => {
  it("counts every place a model is used", () => {
    const usage = modelUsage(slots, draft);
    expect(usage.find((u) => u.ref === "p/opus-4")?.slots.map((s) => s.id)).toEqual(["default-fallback", "tier-expert", "frontier-primary"]);
    expect(usage.find((u) => u.ref === "p/haiku-4")?.slots.map((s) => s.id)).toEqual(["autocomplete", "lookup"]);
    expect(usage[0]?.ref).toBe("p/opus-4");
  });

  it("replaces a model in roles, picks and lists and clamps thinking", () => {
    const { draft: next, notes } = replaceModel(slots, draft, "p/opus-4", "p/opus-5", { levelsOf: () => ["off", "low", "medium", "high", "xhigh"] });
    expect(next.roles.strong).toBe("p/opus-5");
    expect(next.lists["default-fallback"]).toEqual(["p/opus-5", "q/x"]);
    expect(next.thinking["tier-expert"]).toBe("xhigh");
    expect(notes.some((n) => n.includes("max → xhigh"))).toBe(true);
  });

  it("drops a replacement that would duplicate the primary in its fallback list", () => {
    const { draft: next } = replaceModel(slots, draft, "q/x", "p/sonnet-4");
    expect(next.lists["default-fallback"]).toEqual(["p/opus-4"]);
    expect(next.lists["frontier-extra"]).toEqual(["p/sonnet-4"]);
  });

  it("keeps the old model in slots the new model does not fit", () => {
    const { draft: next, notes } = replaceModel(slots, draft, "p/haiku-4", "p/haiku-5", { fits: (slot) => slot.id !== "lookup" });
    expect(next.roles.fast).toBe("p/haiku-5");
    expect(next.picks.lookup).toBe("p/haiku-4");
    expect(notes).toHaveLength(1);
  });

  it("clamps to the nearest supported level, ties going lower", () => {
    expect(clampThinking("max", ["low", "high"])).toBe("high");
    expect(clampThinking("medium", ["low", "high"])).toBe("low");
    expect(clampThinking("", ["low"])).toBe("");
    expect(clampThinking("max", undefined)).toBe("max");
  });

  it("promotes a new frontier release and keeps the previous primary", () => {
    const next = promoteFrontier(slots, draft, "r/new");
    expect(next.picks["frontier-primary"]).toBe("r/new");
    expect(next.lists["frontier-extra"]).toEqual(["p/opus-4", "q/x"]);
  });

  it("suggests newer releases of the same line only", () => {
    const available = ["p/claude-sonnet-4-5", "p/claude-sonnet-5", "p/claude-opus-6", "q/claude-sonnet-9", "p/claude-sonnet-3"];
    expect(upgradeCandidate("p/claude-sonnet-4", available)).toBe("p/claude-sonnet-5");
    expect(upgradeCandidate("p/gpt-6-luna", ["p/gpt-6.1-luna", "p/gpt-7-sol"])).toBe("p/gpt-6.1-luna");
    expect(upgradeCandidate("p/model-20250101", ["p/model-20260101"])).toBeUndefined();
    expect(upgradeCandidate("p/claude-sonnet-5", available)).toBeUndefined();
  });
});
