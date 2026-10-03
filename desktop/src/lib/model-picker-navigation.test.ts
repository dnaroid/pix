import { describe, expect, it } from "vitest";
import { pickerModelIndex, nextPickerThinking } from "./model-picker-navigation";
import { AUTO_MODEL_REF } from "./model-thinking";

describe("model picker keyboard navigation", () => {
  const models = [{ ref: AUTO_MODEL_REF }, { ref: "provider/current" }, { ref: "provider/other" }];

  it("opens and clears search on the staged current model, not pinned Auto", () => {
    expect(pickerModelIndex(models, "provider/current", "", false)).toBe(1);
    expect(pickerModelIndex(models, "provider/other", "  ", false)).toBe(2);
    expect(pickerModelIndex(models, AUTO_MODEL_REF, "", false)).toBe(0);
  });

  it("searches concrete models unless querying Auto, and keeps manage independent", () => {
    expect(pickerModelIndex(models, "provider/current", "current", false)).toBe(1);
    expect(pickerModelIndex(models, "provider/current", "auto", false)).toBe(0);
    expect(pickerModelIndex(models, "provider/current", "", true)).toBe(0);
    expect(pickerModelIndex([], "missing", "", false)).toBe(0);
    expect(pickerModelIndex(models.slice(1), "missing", "current", false)).toBe(0);
  });

  it("cycles supported effort levels in both directions, wrapping at either end", () => {
    const levels = ["low", "medium", "high", "max"];
    expect(nextPickerThinking(levels, "medium", 1)).toBe("high");
    expect(nextPickerThinking(levels, "medium", -1)).toBe("low");
    expect(nextPickerThinking(levels, "max", 1)).toBe("low");
    expect(nextPickerThinking(levels, "low", -1)).toBe("max");
    expect(nextPickerThinking(["off"], "off", 1)).toBe("off");
    expect(nextPickerThinking([], "off", -1)).toBeUndefined();
  });
});
