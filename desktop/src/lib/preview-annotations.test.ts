import { describe, expect, it } from "vitest";
import { insertPreviewAnnotations, renderInlineNote } from "./preview-annotations";
import { highlightCode } from "./syntax-highlight";

describe("Preview inline annotations", () => {
  it("inserts note rows above their lines without adding source lines", () => {
    const { html } = highlightCode("let count = 0;\nfunction render() {}\n", "js");
    const out = insertPreviewAnnotations(html, [{ line: 2, text: "Renders `count`." }, { line: 2, text: "Again." }, { line: 9, text: "ignored" }, { line: 1, text: " " }]);
    const rows = out.split("\n");
    expect(rows).toHaveLength(html.split("\n").length + 1);
    expect(rows[1]).toBe('<span class="preview-annotation" data-annotation-line="2" role="note" aria-label="Note for line 2"><span class="preview-annotation-body">Renders <code>count</code>. Again.</span></span>');
    expect(rows[2]).toContain("sh__line");
    expect((out.match(/class="sh__line"/gu) ?? []).length).toBe((html.match(/class="sh__line"/gu) ?? []).length);
    expect(insertPreviewAnnotations(html, [])).toBe(html);
  });

  it("escapes note text and supports only tiny inline Markdown", () => {
    expect(renderInlineNote("<b>x</b> **bold** *em* `a<b>` 2*3*4")).toBe("&lt;b&gt;x&lt;/b&gt; <strong>bold</strong> <em>em</em> <code>a&lt;b&gt;</code> 2*3*4");
  });
});
