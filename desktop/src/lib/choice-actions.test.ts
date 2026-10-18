import { describe, expect, it } from "vitest";
import { choiceActionsPrompt, latestAssistantMessageId, parseChoiceActions } from "./choice-actions";
import { splitHtmlSandboxSegments } from "./html-sandbox";
import type { TranscriptDisplayItem } from "./transcript-types";

const msg = (id: string, role: "user" | "assistant" | "system") =>
  ({ type: "message", id, role, text: "", attachments: [] }) as TranscriptDisplayItem;

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

  it("activates only the final assistant reply not followed by a user message", () => {
    expect(latestAssistantMessageId([msg("u", "user"), msg("a", "assistant"), msg("s", "system")])).toBe("a");
    expect(latestAssistantMessageId([msg("a", "assistant"), msg("u", "user")])).toBeUndefined();
  });
});
