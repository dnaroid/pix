import { describe, expect, it } from "vitest";
import source from "./ChoiceActionsReply.svelte?raw";
import transcript from "./TranscriptPane.svelte?raw";

describe("quick-choice reply presentation", () => {
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
    expect(transcript).toContain("const choiceReplies = $derived(choiceActionsReplies(displayItems));");
    expect(transcript).toContain("<ChoiceActionsReply actions={choiceReply} />");
    expect(transcript).toContain("{:else if item.text}");
  });
});
