import { describe, expect, it } from "vitest";
import { normalizeProjectFileDestination, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders the transcript Markdown subset", () => {
    const html = renderMarkdown([
      "## Result",
      "",
      "Use **bold**, *emphasis*, ~~old~~, and `code`.",
      "",
      "- first",
      "- [x] done",
      "",
      "> quoted",
    ].join("\n"));

    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>first</li><li class=\"task-item\"><input type=\"checkbox\" disabled checked>done</li></ul>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("renders complete and streaming fenced code without interpreting its contents", () => {
    const complete = renderMarkdown("```ts\nconst tag = '<script>';\n```");
    const streaming = renderMarkdown("```ts\nconst tag = '<script>';\n");

    expect(complete).toContain('<pre><code class="highlighted-code" data-language="typescript">');
    expect(complete).toContain('class="sh__token--keyword"');
    expect(complete).toContain("&lt;script&gt;");
    expect(complete).not.toContain("<script>");
    expect(streaming).toContain('<code class="highlighted-code" data-language="typescript">');
    expect(streaming).toContain("&lt;script&gt;");
    expect(streaming).not.toContain("```");
  });

  it("uses plaintext highlighting for unknown fence languages", () => {
    const html = renderMarkdown("```unknown-lang\n<tag>\n```");

    expect(html).toContain('data-language="plaintext"');
    expect(html).toContain("&lt;tag&gt;");
    expect(html).not.toContain("<tag>");
  });

  it("renders simple tables with alignment", () => {
    const html = renderMarkdown("| Name | Value |\n| :--- | ---: |\n| Pix | **fast** |");

    expect(html).toContain('<div class="table-scroll"><table>');
    expect(html).toContain('<th class="align-left">Name</th>');
    expect(html).toContain('<td class="align-right"><strong>fast</strong></td>');
  });

  it("escapes raw HTML and rejects executable link destinations", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> ![preview](https://example.com/image.png) [run](javascript:alert(1)) [web](https://example.com/a?q=1&b=2)');

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("preview");
    expect(html).not.toContain("image.png");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com/a?q=1&amp;b=2"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("turns bare URLs into external links and leaves surrounding punctuation outside", () => {
    const html = renderMarkdown(
      "Visit https://www.google.com, read (https://en.wikipedia.org/wiki/Pix_(software)), or email mailto:pix@example.com.",
    );

    expect(html).toContain('<a href="https://www.google.com/" data-external-link');
    expect(html).toContain('>https://www.google.com</a>,');
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Pix_(software)"');
    expect(html).toContain('>https://en.wikipedia.org/wiki/Pix_(software)</a>)');
    expect(html).toContain('href="mailto:pix@example.com"');
    expect(html).toContain('>mailto:pix@example.com</a>.');
  });

  it("does not auto-link URLs inside code or create nested links", () => {
    const html = renderMarkdown(
      "`https://code.example` [`src/App.svelte`](https://destination.example)",
    );

    expect(html).toContain("<code>https://code.example</code>");
    expect(html).toContain(
      '<a href="https://destination.example/" data-external-link rel="noopener noreferrer"><code>src/App.svelte</code></a>',
    );
    expect(html.match(/data-external-link/g)).toHaveLength(1);
    expect(html).not.toContain("data-project-file");
  });

  it("renders relative Markdown destinations as project-file preview links", () => {
    const html = renderMarkdown("Open [the app](./src/App.svelte) or [the guide](docs/guide%20one.md#intro).");

    expect(html).toContain('data-project-file="src/App.svelte"');
    expect(html).toContain('title="Preview src/App.svelte"');
    expect(html).toContain('data-project-file="docs/guide one.md"');
    expect(html.match(/data-external-link/g)).toBeNull();
  });

  it("turns inline-code project file paths into preview links", () => {
    const html = renderMarkdown(
      "Changed `desktop/src/components/TranscriptPane.svelte` and `src/App.svelte:42`.",
    );

    expect(html).toContain(
      '<a href="#" data-project-file="desktop/src/components/TranscriptPane.svelte"',
    );
    expect(html).toContain("<code>desktop/src/components/TranscriptPane.svelte</code></a>");
    expect(html).toContain('data-project-file="src/App.svelte"');
  });

  it("keeps ordinary inline code as code", () => {
    const html = renderMarkdown("Run `npm run check` and call `value.toString()`.");

    expect(html).not.toContain("data-project-file");
    expect(html).toContain("<code>npm run check</code>");
    expect(html).toContain("<code>value.toString()</code>");
  });

  it("rejects project-file destinations that are absolute, traversing, or URL-like", () => {
    expect(normalizeProjectFileDestination("src/main.ts")).toBe("src/main.ts");
    expect(normalizeProjectFileDestination("./docs/readme.md#usage")).toBe("docs/readme.md");
    expect(normalizeProjectFileDestination("../secret.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("%2e%2e/secret.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("src/%00secret.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("/tmp/file.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("C:\\tmp\\file.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("https://example.com/file.ts")).toBeUndefined();
  });

  it("keeps incomplete inline markers readable while chunks stream", () => {
    expect(renderMarkdown("Answer **still streaming")).toBe("<p>Answer **still streaming</p>");
    expect(renderMarkdown("Use [partial")).toBe("<p>Use [partial</p>");
  });
});
