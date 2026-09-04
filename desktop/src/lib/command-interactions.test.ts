import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { commandPickerState } from "./command-interactions";

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
      { value: "anthropic/claude-4", label: "Claude 4", description: "anthropic/claude-4", current: true },
      { value: "openai/gpt-5", label: "GPT-5", description: "openai/gpt-5", current: false },
    ]);
  });

  it("builds thinking picker items with effort descriptions", () => {
    const state = commandPickerState("thinking", configOptions);
    expect(state.title).toBe("Select thinking level");
    expect(state.items.map((item) => [item.value, item.description, item.current])).toEqual([
      ["off", "No extended reasoning", false],
      ["medium", "Balanced reasoning", false],
      ["high", "Deeper reasoning", true],
    ]);
  });

  it("flattens grouped select options", () => {
    const grouped: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "a/one",
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
    expect(state.items.map((item) => item.value)).toEqual(["a/one", "a/two", "b/one"]);
    expect(state.items.find((item) => item.value === "a/one")?.current).toBe(true);
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
});
