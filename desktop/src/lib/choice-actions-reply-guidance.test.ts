import { describe, expect, it } from "vitest";
import { CHOICE_ACTIONS_CAPABILITY } from "../../../src/bundled-extensions/choice-actions/contract";
import { splitHtmlSandboxSegments } from "./html-sandbox";

describe("reply-button authoring guidance", () => {
  const replies = "- Готово, расширение загружено\n- ID отличается\n- Ошибка при загрузке";

  it("keeps the reported unfenced replies as ordinary Markdown", () => {
    const text = `Загрузите расширение, затем ответьте.\n\n${replies}`;
    expect(splitHtmlSandboxSegments(text, { actions: true })).toEqual([{ type: "markdown", text }]);
  });

  it("recognizes the reported replies when authored inside a closed pix-actions fence", () => {
    expect(splitHtmlSandboxSegments(`Загрузите расширение.\n\n\`\`\`pix-actions\n${replies}\n\`\`\``, { actions: true })).toEqual([
      { type: "markdown", text: "Загрузите расширение.\n" },
      {
        type: "actions",
        actions: {
          submitLabel: "Continue",
          items: replies.split("\n").map((line) => ({ label: line.slice(2), checked: false })),
          buttons: true,
        },
      },
    ]);
  });

  it("renders both advertised examples as actions only when opted in", () => {
    const segments = splitHtmlSandboxSegments(CHOICE_ACTIONS_CAPABILITY, { actions: true });
    const actions = segments.filter((segment) => segment.type === "actions").map((segment) => segment.actions);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.buttons).toBe(true);
    expect(actions[0]?.items.map((item) => item.label)).toEqual(["Done", "Error loading extension"]);
    expect(actions[1]?.items).toEqual([{ label: "Remove duplicate instructions", checked: true }]);
    expect(splitHtmlSandboxSegments(CHOICE_ACTIONS_CAPABILITY, { actions: false }))
      .toEqual([{ type: "markdown", text: CHOICE_ACTIONS_CAPABILITY }]);
  });
});
