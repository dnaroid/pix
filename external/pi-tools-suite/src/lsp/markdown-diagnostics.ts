import path from "node:path";
import fs from "node:fs";
import type { Diagnostic } from "vscode-languageserver-protocol";

interface LineOffsets {
  readonly text: string;
  readonly starts: number[];
}

function lineOffsets(text: string): LineOffsets {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return { text, starts };
}

function positionAt(offsets: LineOffsets, offset: number): { line: number; character: number } {
  let low = 0;
  let high = offsets.starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets.starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  const line = Math.max(0, high);
  return { line, character: Math.max(0, offset - offsets.starts[line]) };
}

function diagnostic(offsets: LineOffsets, start: number, end: number, message: string, code: string, severity: Diagnostic["severity"] = 1): Diagnostic {
  return {
    severity,
    source: "pi-markdown",
    code,
    message,
    range: {
      start: positionAt(offsets, start),
      end: positionAt(offsets, Math.max(end, start + 1)),
    },
  };
}

function addMarkdownLinkDiagnostics(file: string, text: string, offsets: LineOffsets, out: Diagnostic[]): void {
  const definitions = new Map<string, Array<{ start: number; end: number }>>();
  const usedReferences = new Set<string>();

  for (const match of text.matchAll(/^\s{0,3}\[([^\]\r\n]+)\]:\s*(\S+)/gm)) {
    const ref = match[1].trim().toLocaleLowerCase();
    const start = (match.index ?? 0) + match[0].indexOf(match[1]);
    const end = start + match[1].length;
    const existing = definitions.get(ref) ?? [];
    existing.push({ start, end });
    definitions.set(ref, existing);
  }

  for (const [ref, locations] of definitions) {
    if (locations.length <= 1) continue;
    for (const location of locations) {
      out.push(diagnostic(offsets, location.start, location.end, `Duplicate link definition: '${ref}'`, "link.duplicate-definition", 2));
    }
  }

  for (const match of text.matchAll(/(?<!!)(?:\[[^\]\r\n]+\]\[([^\]\r\n]*)\]|\[([^\]\r\n]+)\]\[\])/g)) {
    const full = match[0];
    const explicit = match[1];
    const collapsed = match[2];
    const ref = (explicit === "" ? collapsed : explicit)?.trim();
    if (!ref) continue;
    const normalized = ref.toLocaleLowerCase();
    usedReferences.add(normalized);
    if (definitions.has(normalized)) continue;
    const start = (match.index ?? 0) + full.lastIndexOf(ref);
    out.push(diagnostic(offsets, start, start + ref.length, `No link definition found: '${ref}'`, "link.no-such-reference"));
  }

  for (const [ref, locations] of definitions) {
    if (usedReferences.has(ref)) continue;
    for (const location of locations) {
      out.push(diagnostic(offsets, location.start, location.end, "Link definition is unused", "link.unused-definition", 4));
    }
  }

  const fileLinkPattern = /(?<!!)\[[^\]\r\n]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of text.matchAll(fileLinkPattern)) {
    const href = match[1];
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
    const [targetPath] = href.split("#", 1);
    if (!targetPath || targetPath.startsWith("mailto:")) continue;
    const decoded = decodeURIComponent(targetPath);
    const absolute = path.resolve(path.dirname(file), decoded);
    try {
      if (!fs.existsSync(absolute)) {
        const start = (match.index ?? 0) + match[0].indexOf(href);
        out.push(diagnostic(offsets, start, start + href.length, `File does not exist: '${href}'`, "link.no-such-file"));
      }
    } catch {
      // Ignore malformed/unsupported local paths.
    }
  }
}

const mermaidStarters = /^(?:---|graph\s+(?:TB|BT|RL|LR|TD)|flowchart\s+(?:TB|BT|RL|LR|TD)|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie(?:\s+title\b)?|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|sankey-beta|xyChart-beta|block-beta|packet-beta|architecture-beta)\b/i;

function mermaidBlocks(text: string): Array<{ content: string; startOffset: number; fenceStart: number; fenceEnd: number }> {
  const blocks: Array<{ content: string; startOffset: number; fenceStart: number; fenceEnd: number }> = [];
  const fencePattern = /^(```|~~~)\s*(?:mermaid|mmd)\b[^\r\n]*\r?\n([\s\S]*?)^\1\s*$/gim;
  for (const match of text.matchAll(fencePattern)) {
    const fenceStart = match.index ?? 0;
    const contentStart = fenceStart + match[0].indexOf(match[2]);
    blocks.push({ content: match[2], startOffset: contentStart, fenceStart, fenceEnd: fenceStart + match[0].length });
  }
  return blocks;
}

function addMermaidDiagnostics(file: string, text: string, offsets: LineOffsets, out: Diagnostic[]): void {
  const extension = path.extname(file).toLocaleLowerCase();
  const blocks = [".mmd", ".mermaid"].includes(extension)
    ? [{ content: text, startOffset: 0, fenceStart: 0, fenceEnd: text.length }]
    : mermaidBlocks(text);

  for (const block of blocks) {
    const lines = block.content.split(/\r?\n/);
    const firstIndex = lines.findIndex((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("%%");
    });
    if (firstIndex === -1) {
      out.push(diagnostic(offsets, block.fenceStart, block.fenceEnd, "Mermaid diagram is empty", "mermaid.empty"));
      continue;
    }

    const beforeFirst = lines.slice(0, firstIndex).join("\n");
    const firstOffset = block.startOffset + (beforeFirst ? beforeFirst.length + 1 : 0) + (lines[firstIndex].match(/^\s*/)?.[0].length ?? 0);
    const firstLine = lines[firstIndex].trim();
    if (!mermaidStarters.test(firstLine)) {
      out.push(diagnostic(offsets, firstOffset, firstOffset + firstLine.length, "Mermaid diagram should start with a supported diagram type such as 'flowchart TD'", "mermaid.missing-diagram-type"));
      continue;
    }

    let runningOffset = block.startOffset;
    for (const line of lines) {
      const arrow = /\b[A-Za-z0-9_]+\s*->\s*[A-Za-z0-9_]+\b/.exec(line);
      if (arrow) {
        out.push(diagnostic(offsets, runningOffset + arrow.index, runningOffset + arrow.index + arrow[0].length, "Mermaid flowchart arrows use '-->' or another Mermaid arrow form, not '->'", "mermaid.invalid-arrow"));
      }
      runningOffset += line.length + 1;
    }
  }
}

export function localMarkdownDiagnostics(file: string, text: string): Diagnostic[] {
  const offsets = lineOffsets(text);
  const diagnostics: Diagnostic[] = [];
  addMarkdownLinkDiagnostics(file, text, offsets, diagnostics);
  addMermaidDiagnostics(file, text, offsets, diagnostics);
  return diagnostics;
}
