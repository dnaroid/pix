import { describe, expect, it } from "vitest";
import { choiceActionsPrompt, parseChoiceActions } from "./choice-actions";
import { splitHtmlSandboxSegments } from "./html-sandbox";

describe("pix-actions blocks", () => {
  it("parses recommended items and the button label", () => {
    expect(parseChoiceActions('pix-actions "Apply selected"', "- [x] One\n- [ ] Two\n")).toEqual({
      submitLabel: "Apply selected",
      items: [{ label: "One", checked: true }, { label: "Two", checked: false }],
    });
    expect(parseChoiceActions("pix-actions", "1. [X] A\n2. [ ] B")?.submitLabel).toBe("Continue");
  });

  it("rejects malformed or out-of-bounds blocks", () => {
    expect(parseChoiceActions("pix-actions", "")).toBeUndefined();
    expect(parseChoiceActions("pix-actions Go", "- [x] Only one")).toEqual({ submitLabel: "Go", items: [{ label: "Only one", checked: true }] });
    expect(parseChoiceActions("pix-actions", "- [x] A\nplain text")).toBeUndefined();
    expect(parseChoiceActions("pix-actions", Array.from({ length: 9 }, (_, i) => `- [ ] ${i}`).join("\n"))).toBeUndefined();
  });

  it("parses plain items as reply buttons and rejects mixed or oversized rows", () => {
    expect(parseChoiceActions("pix-actions", "- Готово\n- Пропустить")).toEqual({
      submitLabel: "Continue",
      items: [{ label: "Готово", checked: false }, { label: "Пропустить", checked: false }],
      buttons: true,
    });
    expect(parseChoiceActions("pix-actions", "- Done\n- [x] Step")).toBeUndefined();
    expect(parseChoiceActions("pix-actions", `- ${"x".repeat(41)}`)).toBeUndefined();
    expect(parseChoiceActions("pix-actions", "- A\n- B\n- C\n- D\n- E")).toBeUndefined();
    expect(parseChoiceActions("pix-actions", "- [x]")).toBeUndefined();
    expect(parseChoiceActions("pix-actions", "Done")).toBeUndefined();
  });

  it("splits only when enabled and keeps incomplete fences as Markdown", () => {
    const text = "Pick:\n```pix-actions Go\n- [x] A\n- [ ] B\n```\nafter";
    expect(splitHtmlSandboxSegments(text, { actions: true }).map((s) => s.type)).toEqual(["markdown", "actions", "markdown"]);
    expect(splitHtmlSandboxSegments(text, { sandbox: true })).toEqual([{ type: "markdown", text }]);
    const open = "```pix-actions\n- [x] A\n- [ ] B";
    expect(splitHtmlSandboxSegments(open, { actions: true })).toEqual([{ type: "markdown", text: open }]);
  });

  it("builds the submitted message in item order", () => {
    const items = [{ label: "A", checked: false }, { label: "B", checked: false }, { label: "C", checked: false }];
    expect(choiceActionsPrompt("Do", items, [2, 0, 2])).toBe("Do:\n1. A\n3. C");
    expect(() => choiceActionsPrompt("Do", items, [])).toThrow();
  });
});
