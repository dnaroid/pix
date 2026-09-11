import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { commandPickerState, desktopCommandPickerState, listCommandPickerState } from "./command-interactions";
import { desktopCommandDefinition } from "./desktop-commands";

const configOptions: SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "anthropic/claude-4",
    options: [
      {
        value: "anthropic/claude-4",
        name: "Claude 4",
        description: "Current default",
      },
      {
        value: "openai/gpt-5",
        name: "GPT-5",
        description: "Fast",
      },
    ],
  },
  {
    id: "thought_level",
    name: "Thought level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "off" },
      { value: "medium", name: "medium" },
      { value: "high", name: "high" },
    ],
  },
];

describe("commandPickerState", () => {
  it("builds model picker items with current selection and value descriptions", () => {
    const state = commandPickerState("model", configOptions);
    expect(state.title).toBe("Select model");
    expect(state.items).toEqual([
      expect.objectContaining({
        value: "anthropic/claude-4",
        label: "anthropic/claude-4",
        description: "Claude 4",
        current: true,
      }),
      expect.objectContaining({
        value: "openai/gpt-5",
        label: "openai/gpt-5",
        description: "GPT-5",
        current: false,
      }),
    ]);
    expect(state.items[0]?.aliases).toEqual(expect.arrayContaining(["Claude 4", "anthropic", "claude-4"]));
  });

  it("builds thinking picker items with effort descriptions", () => {
    const state = commandPickerState("thinking", configOptions);
    expect(state.title).toBe("Select thinking level");
    expect(state.items.map((item) => [item.value, item.description, item.current])).toEqual([
      ["off", "No reasoning/thinking", false],
      ["medium", "Medium reasoning", false],
      ["high", "High reasoning", true],
    ]);
    expect(state.items.find((item) => item.value === "off")?.keywords).toContain("disabled none no reasoning");
  });

  it("flattens grouped select options", () => {
    const grouped: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "b/one",
        options: [
          {
            name: "Group A",
            options: [
              { value: "a/one", name: "One" },
              { value: "a/two", name: "Two" },
            ],
          },
          { value: "b/one", name: "B One" },
        ],
      } as SessionConfigOption,
    ];
    const state = commandPickerState("model", grouped);
    expect(state.items.map((item) => item.value)).toEqual(["b/one", "a/one", "a/two"]);
    expect(state.items.find((item) => item.value === "b/one")?.current).toBe(true);
    expect(state.items.find((item) => item.value === "a/two")?.aliases).toContain("Group A");
  });

  it("returns no items when the selector is missing", () => {
    expect(commandPickerState("model", []).items).toEqual([]);
    expect(commandPickerState("thinking", [{
      id: "autocompact",
      name: "Autocompact",
      type: "boolean",
      currentValue: true,
    }]).items).toEqual([]);
  });

  it("builds searchable jump and history pickers with an initial query", () => {
    const jump = listCommandPickerState("jump", [
      { id: "entry-1", value: "user:1", label: "Fix the parser", description: "abc123" },
    ], "parser");
    expect(jump).toMatchObject({
      command: "jump",
      title: "Jump to user message",
      initialQuery: "parser",
    });

    const history = listCommandPickerState("history", [
      { id: "history:0", value: "Run tests", label: "Run tests" },
    ]);
    expect(history).toMatchObject({
      command: "history",
      title: "Prompt history",
      items: [{ id: "history:0", value: "Run tests", label: "Run tests" }],
    });
  });
});

describe("desktopCommandPickerState", () => {
  it("maps shared command metadata into searchable picker rows", () => {
    const state = desktopCommandPickerState([
      desktopCommandDefinition("session.new"),
      desktopCommandDefinition("session.jump"),
    ], "mac");
    expect(state.command).toBe("commands");
    expect(state.items[0]).toMatchObject({
      value: "session.new",
      label: "New Conversation",
      shortcut: "⌘T",
    });
    expect(state.items[1]?.keywords).toContain("navigate");
  });
});
