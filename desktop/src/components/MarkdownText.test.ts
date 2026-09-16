import { describe, expect, it } from "vitest";
import markdownTextSource from "./MarkdownText.svelte?raw";

describe("MarkdownText fenced code layout", () => {
  it("keeps short blocks intrinsic and wraps long plaintext and Sugar High lines", () => {
    expect(markdownTextSource).toMatch(
      /:global\(pre\)\s*\{[^}]*width: fit-content;[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*\}/,
    );
    expect(markdownTextSource).toMatch(
      /:global\(pre code\)\s*\{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*\}/,
    );
    expect(markdownTextSource).toMatch(
      /:global\(\.highlighted-code \.sh__line\)\s*\{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*\}/,
    );
  });
});
