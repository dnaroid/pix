import { describe, expect, it } from "vitest";
import {
  normalizeHomeFileDestination,
  normalizeLocalFileDestination,
  normalizeProjectFileDestination,
  renderMarkdown,
} from "./markdown";

describe("renderMarkdown", () => {
  it("renders the transcript Markdown subset", () => {
    const html = renderMarkdown([
      "## Result",
      "",
      "Use **bold**, *emphasis*, ***both***, ~~old~~, and `code`.",
      "",
      "- first",
      "- [x] done",
      "",
      "> quoted",
    ].join("\n"));

    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<strong><em>both</em></strong>");
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

  it("emits safe Mermaid render targets with a readable source fallback", () => {
    const html = renderMarkdown('```mermaid\nflowchart LR\n  A["<Start>"] --> B\n```');

    expect(html).toContain('class="mermaid-diagram"');
    expect(html).toContain('data-mermaid-source="flowchart LR\n  A[&quot;&lt;Start&gt;&quot;] --&gt; B"');
    expect(html).toContain('class="mermaid-canvas"');
    expect(html).toContain('<pre class="mermaid-fallback"><code>flowchart LR\n  A[&quot;&lt;Start&gt;&quot;] --&gt; B</code></pre>');
    expect(html).not.toContain("highlighted-code");
    expect(html).not.toContain("<Start>");
  });

  it("renders simple tables with alignment", () => {
    const html = renderMarkdown("| Name | Status | Example |\n| :-- | :--: | --: |\n| Pix | Ready | **fast** |");

    expect(html).toContain('<div class="table-scroll"><table>');
    expect(html).toContain('<th class="align-left">Name</th>');
    expect(html).toContain('<th class="align-center">Status</th>');
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

  it("emits inline preview targets for supported project images and videos", () => {
    const html = renderMarkdown([
      "[Before and after](.pi/artifacts/result.png)",
      "[Demo](artifacts/demo.webm)",
    ].join("\n\n"));

    expect(html).toContain('data-project-media="image"');
    expect(html).toContain('data-project-file=".pi/artifacts/result.png"');
    expect(html).toContain('data-project-media-label="Before and after"');
    expect(html).toContain('data-project-media="video"');
    expect(html).toContain('data-project-file="artifacts/demo.webm"');
    expect(html).toContain('class="markdown-media-caption"');
  });

  it("renders local Markdown image syntax as a preview without embedding remote media", () => {
    const local = renderMarkdown("![Result](artifacts/result.webp)");
    const remote = renderMarkdown("![Remote](https://example.com/result.webp)");

    expect(local).toContain('data-project-media="image"');
    expect(local).toContain('data-project-media-label="Result"');
    expect(remote).toBe("<p>Remote</p>");
    expect(remote).not.toContain("<img");
  });

  it("renders file URL images and videos as local previews with clickable captions", () => {
    const html = renderMarkdown([
      "[Light initial](file:///tmp/qa-shots/01-light-initial.png)",
      "[Demo](file:///tmp/qa-shots/demo%20run.webm)",
    ].join("\n\n"));

    expect(html).toContain('data-local-media="image"');
    expect(html).toContain('data-local-file="/tmp/qa-shots/01-light-initial.png"');
    expect(html).toContain('data-local-media-label="Light initial"');
    expect(html).toContain('data-local-media="video"');
    expect(html).toContain('data-local-file="/tmp/qa-shots/demo run.webm"');
    expect(html).toContain('class="markdown-media-caption"');
  });

  it("keeps non-media file URLs clickable without weakening project path rules", () => {
    const html = renderMarkdown("[Trace](file:///tmp/qa-shots/run.trace.zip)");

    expect(html).toContain('data-local-file="/tmp/qa-shots/run.trace.zip"');
    expect(html).not.toContain("data-local-media");
    expect(normalizeLocalFileDestination("file:///tmp/result.png")).toBe("/tmp/result.png");
    expect(normalizeLocalFileDestination("file:///tmp/result%20one.png#preview")).toBe("/tmp/result one.png");
    expect(normalizeLocalFileDestination("file:relative.png")).toBeUndefined();
    expect(normalizeLocalFileDestination("file:///tmp/%00result.png")).toBeUndefined();
    expect(normalizeLocalFileDestination("https://example.com/result.png")).toBeUndefined();
    expect(normalizeProjectFileDestination("file:///tmp/result.png")).toBeUndefined();
  });

  it("escapes media labels and does not preview unsupported project files", () => {
    const media = renderMarkdown('[A & "B"](artifacts/result.png)');
    const binary = renderMarkdown("[Archive](artifacts/result.zip)");

    expect(media).toContain('data-project-media-label="A &amp; &quot;B&quot;"');
    expect(binary).not.toContain("data-project-media");
    expect(binary).toContain('data-project-file="artifacts/result.zip"');
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

  it("turns home-relative file paths into local preview links", () => {
    const html = renderMarkdown(
      "Open `~/.config/pi/pix.jsonc` or [the config](~/.config/pi/pix.jsonc).",
    );

    expect(html.match(/data-local-file="~\/.config\/pi\/pix.jsonc"/g)).toHaveLength(2);
    expect(html).toContain("title=\"Preview ~/.config/pi/pix.jsonc\"");
    expect(html).not.toContain('data-project-file="~/.config/pi/pix.jsonc"');
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
    expect(normalizeProjectFileDestination("~/.config/pi/pix.jsonc")).toBeUndefined();
    expect(normalizeProjectFileDestination("C:\\tmp\\file.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("https://example.com/file.ts")).toBeUndefined();
  });

  it("normalizes confined home-relative destinations", () => {
    expect(normalizeHomeFileDestination("~/.config/pi/pix.jsonc")).toBe("~/.config/pi/pix.jsonc");
    expect(normalizeHomeFileDestination("~\\.config\\pi\\pix.jsonc#preview"))
      .toBe("~/.config/pi/pix.jsonc");
    expect(normalizeHomeFileDestination("~/../secret.txt")).toBeUndefined();
    expect(normalizeHomeFileDestination("~/%2e%2e/secret.txt")).toBeUndefined();
    expect(normalizeHomeFileDestination("/tmp/file.txt")).toBeUndefined();
    expect(normalizeHomeFileDestination("~other/file.txt")).toBeUndefined();
  });

  it("keeps incomplete inline markers readable while chunks stream", () => {
    expect(renderMarkdown("Answer **still streaming")).toBe("<p>Answer **still streaming</p>");
    expect(renderMarkdown("Use [partial")).toBe("<p>Use [partial</p>");
  });
});
