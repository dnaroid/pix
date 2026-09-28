import { describe, expect, it } from "vitest";
import {
  removeTodoThinkingOverrideFromSource,
  renameTodoThinkingOverrideInSource,
  setTodoThinkingOverrideInSource,
  todoThinkingOverridePatternKey,
  todoThinkingOverrideRows,
} from "./todo-thinking-overrides-settings";
import { parseSettingsSource } from "./settings";

describe("todo thinking override settings", () => {
  it("merges inherited defaults with explicit values and removal markers", () => {
    expect(todoThinkingOverrideRows(
      {
        "zai/glm-5.3": "max",
        "cheap-provider/*": "high",
      },
      {
        "ZAI/GLM-5.3": null,
        "openai-codex/gpt-*": "medium",
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
        level: "high",
        inherited: true,
        explicit: false,
      },
      {
        pattern: "openai-codex/gpt-*",
        level: "medium",
        inherited: false,
        explicit: true,
      },
    ]);
  });

  it("preserves configured string values so the structured UI can repair them", () => {
    expect(todoThinkingOverrideRows({}, {
      "provider/model": "future-level",
      ignored: 42,
    })).toEqual([
      {
        pattern: "provider/model",
        level: "future-level",
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
      '    "zai/glm-5.3": "max",',
      '    "old/*": "high"',
      "  }",
      "}",
    ].join("\n");

    const added = setTodoThinkingOverrideInSource(source, "openai-codex/gpt-*", "medium");
    expect(added).toContain("// Keep surrounding JSONC comments.");
    expect(parseSettingsSource(added).value.todoThinkingOverrides).toMatchObject({
      "zai/glm-5.3": "max",
      "old/*": "high",
      "openai-codex/gpt-*": "medium",
    });

    const renamed = renameTodoThinkingOverrideInSource(added, {
      pattern: "old/*",
      level: "high",
      inherited: false,
      explicit: true,
    }, "cheap/*");
    expect(parseSettingsSource(renamed).value.todoThinkingOverrides).toMatchObject({
      "zai/glm-5.3": "max",
      "cheap/*": "high",
      "openai-codex/gpt-*": "medium",
    });

    const removed = removeTodoThinkingOverrideFromSource(renamed, {
      pattern: "openai-codex/gpt-*",
      level: "medium",
      inherited: false,
      explicit: true,
    });
    expect(parseSettingsSource(removed).value.todoThinkingOverrides).toEqual({
      "zai/glm-5.3": "max",
      "cheap/*": "high",
    });
  });
});
