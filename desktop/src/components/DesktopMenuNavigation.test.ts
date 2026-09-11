import { describe, expect, it } from "vitest";
import composerSource from "./PromptComposer.svelte?raw";
import transcriptSource from "./TranscriptPane.svelte?raw";

describe("desktop menu keyboard wiring", () => {
  it("gives composer overflow menus shared arrow/type-ahead navigation", () => {
    expect(composerSource).toContain("handleComposerMenuKeydown");
    expect(composerSource).toContain("menuFocusIndex(items, currentIndex, event.key)");
    expect(composerSource).toContain("menuTypeaheadFocusIndex(items, currentIndex, query)");
    expect(composerSource).toContain("composerMenuTrigger?.focus()");
  });

  it("gives user-message menus the same keyboard contract", () => {
    expect(transcriptSource).toContain("handleUserMessageMenuKeydown");
    expect(transcriptSource).toContain("menuFocusIndex(items, currentIndex, event.key)");
    expect(transcriptSource).toContain("menuTypeaheadFocusIndex(items, currentIndex, query)");
    expect(transcriptSource).toContain("closeUserMessageMenu(true)");
  });
});
