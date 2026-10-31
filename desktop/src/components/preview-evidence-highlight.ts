import { renderMarkdown } from "../lib/markdown";

const HIGHLIGHT_NAME = "pix-preview-evidence";
const SECTION_CLASS = "preview-evidence-section";
const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL", "LI", "PRE", "DIV", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "FIGURE", "BR", "HR"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "BUTTON", "SVG", "CANVAS", "INPUT"]);

interface TextPosition { readonly node: Text; readonly offset: number }
export interface EvidenceText {
  readonly text: string;
  readonly positions: readonly (TextPosition | undefined)[];
}

/** Keep character-to-DOM positions while folding only rendered whitespace. */
export function collectEvidenceText(roots: readonly Node[]): EvidenceText {
  const characters: string[] = [];
  const positions: (TextPosition | undefined)[] = [];
  let space = false;
  function visit(node: Node): void {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      for (let offset = 0; offset < value.length; offset += 1) {
        const character = value[offset]!;
        if (/\s/u.test(character)) { space = true; continue; }
        if (space && characters.length) { characters.push(" "); positions.push(undefined); }
        space = false;
        characters.push(character);
        positions.push({ node: node as Text, offset });
      }
      return;
    }
    const element = node.nodeType === 1 ? node as Element : undefined;
    const tag = element?.tagName.toUpperCase();
    if (element && (SKIP_TAGS.has(tag!) || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true"
      || element.classList.contains("mermaid-canvas") || element.classList.contains("katex-mathml"))) return;
    const block = Boolean(tag && BLOCK_TAGS.has(tag)) || Boolean(element?.classList.contains("sh__line"));
    if (block) space = true;
    for (const child of Array.from(node.childNodes)) visit(child);
    if (block) space = true;
  }
  for (const root of roots) visit(root);
  return { text: characters.join(""), positions };
}

/** A second unique match is required in the rendered, source-mapped blocks. */
export function renderedEvidenceRange(document: Document, blocks: readonly HTMLElement[], renderedQuote: string): Range | undefined {
  if (!renderedQuote) return undefined;
  const haystack = collectEvidenceText(blocks);
  const start = haystack.text.indexOf(renderedQuote);
  if (start < 0 || haystack.text.indexOf(renderedQuote, start + 1) >= 0) return undefined;
  const first = haystack.positions[start];
  const last = haystack.positions[start + renderedQuote.length - 1];
  if (!first || !last) return undefined;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

interface EvidenceHighlightRegistry {
  get(name: string): unknown;
  set(name: string, highlight: unknown): unknown;
  delete(name: string): boolean;
}
interface EvidenceHighlightWindow {
  CSS?: { highlights?: EvidenceHighlightRegistry };
  Highlight?: new (...ranges: Range[]) => unknown;
}

export interface EvidenceDecoration {
  readonly status: "exact" | "section" | "source";
  readonly target?: HTMLElement;
  readonly range?: Range;
  readonly cleanup: () => void;
}

/** Only call after exact, unique source-text validation against the loaded file. */
export function decorateEvidence(document: Document, blocks: readonly HTMLElement[], quote: string): EvidenceDecoration {
  const template = document.createElement("template");
  // Reuse the same escaping renderer as Preview. Parsing in an inert template
  // does not resolve images, links, or Markdown UI actions from the quotation.
  template.innerHTML = renderMarkdown(quote);
  const renderedQuote = collectEvidenceText([template.content]).text;
  const range = renderedEvidenceRange(document, blocks, renderedQuote);
  const view = document.defaultView as unknown as EvidenceHighlightWindow | null;
  const registry = view?.CSS?.highlights;
  const Highlight = view?.Highlight;
  if (range && registry && Highlight) {
    const highlight = new Highlight(range);
    registry.set(HIGHLIGHT_NAME, highlight);
    return {
      status: "exact", target: blocks[0], range,
      cleanup: () => { if (registry.get(HIGHLIGHT_NAME) === highlight) registry.delete(HIGHLIGHT_NAME); },
    };
  }
  for (const block of blocks) block.classList.add(SECTION_CLASS);
  return {
    status: blocks.length ? "section" : "source", target: blocks[0], range,
    cleanup: () => { for (const block of blocks) block.classList.remove(SECTION_CLASS); },
  };
}
