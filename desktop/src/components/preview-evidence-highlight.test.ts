import { describe, expect, it, vi } from "vitest";
import { collectEvidenceText, decorateEvidence, renderedEvidenceRange } from "./preview-evidence-highlight";

function text(value: string): Text { return { nodeType: 3, nodeValue: value } as Text; }
function element(tag: string, children: readonly Node[] = [], attributes: Record<string, string> = {}): HTMLElement {
  const classes = new Set((attributes.class ?? "").split(" "));
  return {
    nodeType: 1, tagName: tag, childNodes: children,
    classList: { contains: (name: string) => classes.has(name), add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    hasAttribute: (name: string) => Object.hasOwn(attributes, name),
    getAttribute: (name: string) => attributes[name] ?? null,
  } as unknown as HTMLElement;
}

function documentFixture(quoteText = "five retries", highlights = true) {
  const range = { setStart: vi.fn(), setEnd: vi.fn() };
  const registry = new Map<string, unknown>();
  const template = { content: element("TEMPLATE", [text(quoteText)]), innerHTML: "" };
  const document = {
    createRange: () => range,
    createElement: () => template,
    defaultView: highlights ? { CSS: { highlights: registry }, Highlight: class {} } : {},
  } as unknown as Document;
  return { document, range, registry, template };
}

describe("rendered Wiki evidence highlighting", () => {
  it("selects literal text across formatted inline elements with exact DOM offsets", () => {
    const first = text("five");
    const last = text(" retries.");
    const blocks = [element("P", [text("Rule: "), element("STRONG", [first]), last])];
    const f = documentFixture();
    expect(renderedEvidenceRange(f.document, blocks, "five retries")).toBe(f.range);
    expect(f.range.setStart).toHaveBeenCalledExactlyOnceWith(first, 0);
    expect(f.range.setEnd).toHaveBeenCalledExactlyOnceWith(last, 8);
  });

  it("preserves block boundaries and ignores controls and hidden text", () => {
    const list = element("UL", [
      element("LI", [text("One "), element("A", [text("value")])]),
      element("LI", [text("Second\r\nline"), element("BUTTON", [text("Copy")]), element("SPAN", [text("hidden")], { "aria-hidden": "true" })]),
    ]);
    expect(collectEvidenceText([list]).text).toBe("One value Second line");
  });

  it("does not invent a rendered location for a missing or repeated quotation", () => {
    const f = documentFixture();
    expect(renderedEvidenceRange(f.document, [element("P", [text("five retries; five retries")])], "five retries")).toBeUndefined();
    expect(renderedEvidenceRange(f.document, [element("P", [text("seven retries")])], "five retries")).toBeUndefined();
    expect(f.range.setStart).not.toHaveBeenCalled();
  });

  it("uses a separate owned CSS highlight and does not clear a later owner", () => {
    const f = documentFixture();
    const blocks = [element("P", [text("five retries")])];
    const decoration = decorateEvidence(f.document, blocks, "**five** retries");
    expect(f.template.innerHTML).toContain("<strong>five</strong>");
    expect(decoration.status).toBe("exact");
    expect([...f.registry.keys()]).toEqual(["pix-preview-evidence"]);
    const replacement = {};
    f.registry.set("pix-preview-evidence", replacement);
    decoration.cleanup();
    expect(f.registry.get("pix-preview-evidence")).toBe(replacement);
    const current = decorateEvidence(f.document, blocks, "**five** retries");
    current.cleanup();
    expect(f.registry.size).toBe(0);
  });

  it("makes section and source-text fallbacks explicit and removes their decoration", () => {
    const f = documentFixture("five retries", false);
    const blocks = [element("P", [text("five retries")])];
    const decoration = decorateEvidence(f.document, blocks, "five retries");
    expect(decoration.status).toBe("section");
    expect(blocks[0]!.classList.contains("preview-evidence-section")).toBe(true);
    decoration.cleanup();
    expect(blocks[0]!.classList.contains("preview-evidence-section")).toBe(false);
    expect(decorateEvidence(f.document, [], "five retries").status).toBe("source");
  });
});
