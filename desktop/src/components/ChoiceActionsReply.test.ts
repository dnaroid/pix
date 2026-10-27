import { describe, expect, it } from "vitest";
import source from "./ChoiceActionsReply.svelte?raw";
import transcript from "./TranscriptPane.svelte?raw";
import markdown from "./MarkdownText.svelte?raw";
// @ts-expect-error Node fs import in Vitest runner (frontend tsconfig omits Node globals)
import { readFileSync } from "node:fs";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("quick-choice reply presentation", () => {
  it("allows native text selection and copy inside the non-selectable transcript entry", () => {
    expect(source).toContain("data-choice-actions-reply");
    expect(styles).toMatch(/\.transcript-pane \.transcript-entry :is\([^)]*\[data-choice-actions-reply\][^)]*\)\s*\{\s*-webkit-user-select: text;\s*user-select: text;\s*cursor: text;/);
  });

  it("keeps selected user-reply text bright and dims only unselected text", () => {
    expect(source).toContain('!item.checked && "opacity-60"');
    expect(source).not.toMatch(/<li[^>]*opacity-60/);
    expect(source).toContain("rounded-sm border opacity-60");
  });

  it("paints native selection for assistant option labels and static reply text", () => {
    const selectionRule = styles.slice(styles.indexOf(".transcript-pane :is(.markdown-text, .tool-result, .diff-content)::selection,"));
    const paintedRule = selectionRule.slice(0, selectionRule.indexOf("}") + 1);
    expect(paintedRule).toContain(".transcript-pane [data-choice-actions] .select-text::selection,");
    expect(paintedRule).toContain(".transcript-pane [data-choice-actions] .select-text *::selection,");
    expect(paintedRule).toContain(".transcript-pane [data-choice-actions-reply]::selection,");
    expect(paintedRule).toContain(".transcript-pane [data-choice-actions-reply] *::selection,");
    expect(paintedRule).toContain("background: var(--selection);");
    expect(paintedRule).toContain("color: var(--selection-foreground);");
  });

  it("uses the same checkbox visuals with no interactive controls", () => {
    expect(source).toContain("cursor-default");
    expect(source).toContain("opacity-60");
    expect(source).toContain('from "@lucide/svelte/icons/check"');
    expect(source).toContain('"border-primary" : "border-muted-foreground/50"');
    expect(source).toContain("{#if item.checked}<Check");
    expect(source).toContain('"Selected: " : "Not selected: "');
    expect(source).not.toMatch(/<button|<input|onclick|onSubmit|role="checkbox"/);
  });

  it("renders recognized user replies without replacing their stored text", () => {
    expect(transcript).toContain("const choicePresentation = $derived(choiceActionsPresentation(displayItems));");
    expect(transcript).toContain("<ChoiceActionsReply actions={choiceReply} />");
    expect(transcript).toContain("{:else if item.text}");
  });

  it("hides only answered source checklists while retaining the user receipt", () => {
    expect(transcript).toContain("answeredChoiceActions={choicePresentation.answeredBlocks.get(item.id)}");
    expect(markdown).toContain("onChoiceActionsSubmit && !answeredChoiceActions?.has(actionSegments.indexOf(segment))");
  });
});
