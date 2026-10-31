import { describe, expect, it } from "vitest";
import { modelSetupOverrides } from "./model-setup-overrides";
import type { ModelSetupSlot } from "./acp-pix-extensions";
import { modelUsage, replaceModel } from "./model-setup-replace";

const slots: ModelSetupSlot[] = [
  { id: "knowledge-judge", label: "Contradiction judge", group: "Assistant", role: "main", optional: true, thinking: true },
  { id: "knowledge-judge-desktop", label: "Desktop override", group: "Assistant", role: "main", optional: true, thinking: true },
  { id: "default", label: "Default", group: "Sessions", role: "main", thinking: true },
];

describe("wizard judge overrides", () => {
  it("distinguishes untouched optional fields from explicit model and reasoning resets", () => {
    expect(modelSetupOverrides(slots, {}, {}, {})).toEqual({});
    expect(modelSetupOverrides(slots, { "knowledge-judge-desktop": "" }, {}, { "knowledge-judge-desktop": "", default: "" }))
      .toEqual({ "knowledge-judge-desktop": "", "knowledge-judge-desktop:thinking": "" });
  });
  it("keeps judge and RAG choices independent and preserves fallback lists", () => {
    expect(modelSetupOverrides(slots, { "knowledge-judge": "p/judge", rag: "p/rag" },
      { "default-fallback": ["p/other"] }, { "knowledge-judge": "low", default: "high" }))
      .toEqual({ "knowledge-judge": "p/judge", rag: "p/rag", "default-fallback": ["p/other"],
        "knowledge-judge:thinking": "low", "default:thinking": "high" });
  });
  it("includes both judge locations in In use and replace-everywhere without filling empty inheritance", () => {
    const draft = { roles: { main: "p/main", fast: "p/fast", strong: "p/strong" },
      picks: { "knowledge-judge": "p/old", "knowledge-judge-desktop": "p/old" }, lists: {}, thinking: {} };
    expect(modelUsage(slots, draft).find(entry => entry.ref === "p/old")?.slots.map(slot => slot.id))
      .toEqual(["knowledge-judge", "knowledge-judge-desktop"]);
    const replaced = replaceModel(slots, draft, "p/old", "p/new");
    expect(replaced.draft.picks).toEqual({ "knowledge-judge": "p/new", "knowledge-judge-desktop": "p/new" });
    const inherited = replaceModel(slots, { ...draft, picks: { "knowledge-judge": "p/old", "knowledge-judge-desktop": "" } }, "p/old", "p/new");
    expect(inherited.draft.picks["knowledge-judge-desktop"]).toBe("");
  });
});
