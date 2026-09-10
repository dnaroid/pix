import { describe, expect, it } from "vitest";
import { parseSettingsSource } from "./settings";
import { updateVisibleModelRefsInPixConfig, visibleModelRefsFromPixConfig } from "./model-visibility";

describe("model visibility config", () => {
  it("treats an omitted whitelist as all models visible", () => {
    expect(visibleModelRefsFromPixConfig(`{ "defaultModel": { "modelRef": "openai/test" } }`)).toBeUndefined();
  });

  it("normalizes an explicit whitelist including an empty one", () => {
    expect(visibleModelRefsFromPixConfig(`{ "visibleModels": [" openai/a ", "openai/a", "zai/b"] }`)).toEqual([
      "openai/a",
      "zai/b",
    ]);
    expect(visibleModelRefsFromPixConfig(`{ "visibleModels": [] }`)).toEqual([]);
  });

  it("updates only visibleModels while preserving JSONC comments", () => {
    const updated = updateVisibleModelRefsInPixConfig(`{
      // keep me
      "defaultModel": { "modelRef": "openai/a" }
    }`, ["zai/b", "zai/b", "openai/a"]);

    expect(updated).toContain("// keep me");
    expect(parseSettingsSource(updated).value.visibleModels).toEqual(["zai/b", "openai/a"]);
  });
});
