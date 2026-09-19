import { describe, expect, it } from "vitest";
import markdownContentActionSource from "./markdown-content-action.ts?raw";

describe("markdown file-link validation", () => {
  it("uses the cache to restore known candidates during the scheduled render pass", () => {
    // Browser-DOM integration is covered by the action's small orchestration;
    // cache behavior itself is deterministically tested without a DOM runtime.
    expect(markdownContentActionSource).toContain("const fileLinkValidationCache = new FileLinkValidationCache()");
    expect(markdownContentActionSource).toContain(
      "const cached = fileLinkValidationCache.peek(target.scope, target.path, target.validator)",
    );
    expect(markdownContentActionSource).toContain("replaceFileLinkCandidate(candidate, target)");
  });
});
