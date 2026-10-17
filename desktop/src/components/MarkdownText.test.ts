import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import MarkdownText from "./MarkdownText.svelte";
import markdownTextSource from "./MarkdownText.svelte?raw";

describe("MarkdownText streaming HTML sandbox", () => {
  const text = "Before\n```pix-html\n<h1>hidden-source-marker</h1>\n<script>partial";

  it("renders a compact status instead of incomplete HTML source", () => {
    const html = render(MarkdownText, { props: {
      text, enableHtmlSandbox: true, onHtmlSandboxSubmit: async () => "sent" as const,
    } }).body;
    expect(html).toContain("Before");
    expect(html).toContain('role="status"');
    expect(html).toContain("awaiting complete block");
    expect(html).not.toContain("hidden-source-marker");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("<iframe");
  });

  it("keeps ordinary Markdown source when sandbox rendering is disabled", () => {
    const html = render(MarkdownText, { props: { text } }).body;
    expect(html).toContain("hidden-source-marker");
    expect(html).toContain("<pre");
    expect(html).not.toContain("awaiting complete block");
  });
});

describe("MarkdownText video theme", () => {
  it("themes both the video surface and WebKit's native player backdrop", () => {
    expect(markdownTextSource).toMatch(
      /:global\(video\.markdown-media-content\)\s*\{[^}]*background: var\(--background\);[^}]*color-scheme: light dark;/,
    );
    expect(markdownTextSource).toMatch(
      /:global\(video\.markdown-media-content::-webkit-media-controls-panel\)\s*\{[^}]*background-color: var\(--background\);/,
    );
  });
});

describe("MarkdownText fenced code layout", () => {
  it("keeps the copy button square with centered icon and out-of-flow feedback", () => {
    expect(markdownTextSource).toMatch(
      /:global\(\.markdown-code-copy\)\s*\{[^}]*justify-content: center;[^}]*width: 1\.5rem;[^}]*height: 1\.5rem;[^}]*padding: 0;/,
    );
    expect(markdownTextSource).toMatch(
      /:global\(\.markdown-code-copy > span\)\s*\{[^}]*position: absolute;/,
    );
  });
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
