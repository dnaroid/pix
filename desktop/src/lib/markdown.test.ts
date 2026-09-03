import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

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

    expect(complete).toBe('<pre><code data-language="ts">const tag = &#39;&lt;script&gt;&#39;;</code></pre>');
    expect(streaming).toBe('<pre><code data-language="ts">const tag = &#39;&lt;script&gt;&#39;;\n</code></pre>');
    expect(streaming).not.toContain("```");
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

  it("keeps incomplete inline markers readable while chunks stream", () => {
    expect(renderMarkdown("Answer **still streaming")).toBe("<p>Answer **still streaming</p>");
    expect(renderMarkdown("Use [partial")).toBe("<p>Use [partial</p>");
  });
});
