import { describe, expect, it } from "vitest";
import promptComposerSource from "./PromptComposer.svelte?raw";

describe("PromptComposer project path drop", () => {
  it("accepts project-tree drops for any active conversation target, including draft sessions", () => {
    const guard = promptComposerSource.match(
      /function canAcceptProjectTreeDrop\(\): boolean \{[\s\S]*?\n  \}/u,
    )?.[0];

    expect(guard).toContain("&& hasConversationTarget;");
    expect(guard).not.toContain("activeSessionId");
  });
});
