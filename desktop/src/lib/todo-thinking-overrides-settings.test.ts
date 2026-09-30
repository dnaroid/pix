import { describe, expect, it } from "vitest";
import {
  removeTodoThinkingOverrideFromSource,
  renameTodoThinkingOverrideInSource,
  setTodoThinkingOverrideInSource,
  todoThinkingOverridePatternKey,
  todoThinkingOverrideRows,
  todoThinkingRangeError,
} from "./todo-thinking-overrides-settings";
import { parseSettingsSource } from "./settings";

describe("todo thinking override settings", () => {
  it("validates ranges", () => {
    expect(todoThinkingRangeError({ min: "low", max: "medium" })).toBeUndefined();
    expect(todoThinkingRangeError({ min: "high", max: "low" })).toContain("Min");
    expect(todoThinkingRangeError({ min: "future", max: "max" })).toBeDefined();
  });

  it("merges ranges atomically and saves both bounds while preserving JSONC", () => {
    const range = { min: "low", max: "medium" };
    expect(todoThinkingOverrideRows({ "opus/*": { min: "high", max: "high" } }, { "opus/*": range })[0]).toEqual({
      pattern: "opus/*", level: range, inherited: true, explicit: true,
    });
    const source = '{ // preserve\n "todoThinkingOverrides": { "other": { "min": "high", "max": "high" } } }';
    const saved = setTodoThinkingOverrideInSource(source, "opus/*", range);
    expect(saved).toContain("// preserve");
    expect(parseSettingsSource(saved).value.todoThinkingOverrides).toEqual({ other: { min: "high", max: "high" }, "opus/*": range });
  });
  it("merges inherited defaults with explicit values and removal markers", () => {
    expect(todoThinkingOverrideRows(
      {
        "zai/glm-5.3": { min: "max", max: "max" },
        "cheap-provider/*": { min: "low", max: "high" },
      },
      {
        "ZAI/GLM-5.3": null,
        "openai-codex/gpt-*": { min: "low", max: "medium" },
      },
    )).toEqual([
      {
        pattern: "ZAI/GLM-5.3",
        level: null,
        inherited: true,
        explicit: true,
      },
      {
        pattern: "cheap-provider/*",
        level: { min: "low", max: "high" },
        inherited: true,
        explicit: false,
      },
      {
        pattern: "openai-codex/gpt-*",
        level: { min: "low", max: "medium" },
        inherited: false,
        explicit: true,
      },
    ]);
  });

  it("ignores strings and preserves configured range values so the UI can repair them", () => {
    expect(todoThinkingOverrideRows({}, {
      "old/model": "max",
      "provider/model": { min: "future-level", max: "max" },
      ignored: 42,
    })).toEqual([
      {
        pattern: "provider/model",
        level: { min: "future-level", max: "max" },
        inherited: false,
        explicit: true,
      },
    ]);
  });

  it("normalizes patterns for duplicate detection", () => {
    expect(todoThinkingOverridePatternKey("  ZAI/GLM-5.3 ")).toBe("zai/glm-5.3");
  });

  it("updates, renames, and removes override keys without replacing the whole config", () => {
    const source = [
      "{",
      "  // Keep surrounding JSONC comments.",
      '  "todoThinking": true,',
      '  "todoThinkingOverrides": {',
      '    "zai/glm-5.3": { "min": "max", "max": "max" },',
      '    "old/*": { "min": "high", "max": "high" }',
      "  }",
      "}",
    ].join("\n");

    const added = setTodoThinkingOverrideInSource(source, "openai-codex/gpt-*", { min: "low", max: "medium" });
    expect(added).toContain("// Keep surrounding JSONC comments.");
    expect(parseSettingsSource(added).value.todoThinkingOverrides).toMatchObject({
      "zai/glm-5.3": { min: "max", max: "max" },
      "old/*": { min: "high", max: "high" },
      "openai-codex/gpt-*": { min: "low", max: "medium" },
    });

    const renamed = renameTodoThinkingOverrideInSource(added, {
      pattern: "old/*",
      level: { min: "high", max: "high" },
      inherited: false,
      explicit: true,
    }, "cheap/*");
    expect(parseSettingsSource(renamed).value.todoThinkingOverrides).toMatchObject({
      "zai/glm-5.3": { min: "max", max: "max" },
      "cheap/*": { min: "high", max: "high" },
      "openai-codex/gpt-*": { min: "low", max: "medium" },
    });

    const removed = removeTodoThinkingOverrideFromSource(renamed, {
      pattern: "openai-codex/gpt-*",
      level: { min: "low", max: "medium" },
      inherited: false,
      explicit: true,
    });
    expect(parseSettingsSource(removed).value.todoThinkingOverrides).toEqual({
      "zai/glm-5.3": { min: "max", max: "max" },
      "cheap/*": { min: "high", max: "high" },
    });
  });
});
