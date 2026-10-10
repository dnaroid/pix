import { describe, expect, it } from "vitest";
import { modelThinkingConfigState } from "./model-thinking";
import {
  parseSessionTabModels, serializeSessionTabModels, sessionTabModel, sessionTabModelDisplayOptions,
} from "./session-tab-model";

const model = { modelRef: "pi-claude-code-provider/sonnet", modelName: "Sonnet", thinking: "high" };

describe("display-only session tab models", () => {
  it("round trips only the selection, without catalog or runtime metadata", () => {
    const options = sessionTabModelDisplayOptions(model);
    expect(sessionTabModel(options)).toEqual(model);
    const models = new Map([["/project", new Map([["session", model]])]]);
    expect(parseSessionTabModels(serializeSessionTabModels(models))).toEqual(models);
    const display = modelThinkingConfigState(options);
    expect(display.currentModel?.name).toBe("Sonnet");
    expect(display.currentThinking).toBe("high");
    expect(display.models).toHaveLength(1);
    expect(sessionTabModel([])).toBeUndefined();
  });

  it("ignores missing, corrupt, legacy and malformed entries independently", () => {
    for (const raw of [null, "{", "[]", "null", '"old"']) {
      expect(parseSessionTabModels(raw).size).toBe(0);
    }
    const parsed = parseSessionTabModels(JSON.stringify({
      "/project": {
        valid: { ...model, secret: "must not survive" },
        empty: { ...model, thinking: "" },
        wrongType: { ...model, modelRef: 42 },
        oversized: { ...model, modelName: "x".repeat(513) },
        array: [model],
      },
      "/other": [],
    }));
    expect(parsed).toEqual(new Map([["/project", new Map([["valid", model]])]]));
  });
});
