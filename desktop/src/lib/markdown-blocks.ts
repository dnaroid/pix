import { highlightCode } from "./syntax-highlight";
import type { MarkdownRenderContext } from "./markdown-context";
import { escapeAttribute, escapeHtml } from "./markdown-escape";
import { isClosingFence, parseFence } from "./markdown-fences";
import { renderInline } from "./markdown-inline";

const MAX_BLOCK_DEPTH = 4;

type TableAlignment = "center" | "left" | "right" | undefined;

export function renderBlocks(lines: readonly string[], depth: number, context: MarkdownRenderContext): string {
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = parseFence(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !isClosingFence(lines[index] ?? "", fence)) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const source = body.join("\n");
      if (fence.language.toLowerCase() === "mermaid") {
        const escapedSource = escapeHtml(source);
        output.push(
          `<figure class="mermaid-diagram" data-mermaid-source="${escapeAttribute(source)}">`
          + '<div class="mermaid-canvas" role="img" aria-label="Mermaid diagram" aria-busy="true"></div>'
          + `<pre class="mermaid-fallback"><code>${escapedSource}</code></pre>`
          + "</figure>",
        );
        continue;
      }
      const highlighted = highlightCode(source, fence.language);
      output.push(`<pre><code class="highlighted-code" data-language="${highlighted.language}">${highlighted.html}</code></pre>`);
      continue;
    }

    const table = parseTable(lines, index, context);
    if (table) {
      output.push(table.html);
      index += table.lineCount;
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const source = heading[2] ?? "";
      const id = context.headingAnchors ? ` id="${escapeAttribute(nextHeadingSlug(source, context))}"` : "";
      output.push(`<h${level}${id}>${renderInline(source, 0, true, context)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(/^ {0,3}>[ \t]?(.*)$/);
        if (!match) break;
        quoteLines.push(match[1] ?? "");
        index += 1;
      }
      const quote = depth < MAX_BLOCK_DEPTH
        ? renderBlocks(quoteLines, depth + 1, context)
        : `<p>${renderInline(quoteLines.join("\n"), 0, true, context)}</p>`;
      output.push(`<blockquote>${quote}</blockquote>`);
      continue;
    }

    const list = parseList(lines, index, context);
    if (list) {
      output.push(list.html);
      index += list.lineCount;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join("\n"), 0, true, context)}</p>`);
  }

  return output.join("");
}

function nextHeadingSlug(source: string, context: MarkdownRenderContext): string {
  const base = source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "section";
  const count = context.headingSlugs.get(base) ?? 0;
  context.headingSlugs.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function parseList(
  lines: readonly string[],
  start: number,
  context: MarkdownRenderContext,
): { html: string; lineCount: number } | undefined {
  const first = listItem(lines[start] ?? "");
  if (!first) return undefined;

  const items: string[] = [];
  let index = start;
  const startAttribute = first.ordered && first.number !== 1 ? ` start="${first.number}"` : "";

  while (index < lines.length) {
    const item = listItem(lines[index] ?? "");
    if (!item || item.ordered !== first.ordered) break;

    const task = item.text.match(/^\[([ xX])\][ \t]+(.*)$/);
    if (task) {
      const checked = task[1]?.toLowerCase() === "x" ? " checked" : "";
      items.push(`<li class="task-item"><input type="checkbox" disabled${checked}>${renderInline(task[2] ?? "", 0, true, context)}</li>`);
    } else {
      items.push(`<li>${renderInline(item.text, 0, true, context)}</li>`);
    }
    index += 1;
  }

  const tag = first.ordered ? "ol" : "ul";
  return { html: `<${tag}${startAttribute}>${items.join("")}</${tag}>`, lineCount: index - start };
}

function listItem(line: string): { ordered: boolean; number: number; text: string } | undefined {
  const unordered = line.match(/^ {0,3}[-+*][ \t]+(.+)$/);
  if (unordered) return { ordered: false, number: 1, text: unordered[1] ?? "" };
  const ordered = line.match(/^ {0,3}(\d{1,9})[.)][ \t]+(.+)$/);
  if (!ordered) return undefined;
  return { ordered: true, number: Number(ordered[1]), text: ordered[2] ?? "" };
}

function parseTable(
  lines: readonly string[],
  start: number,
  context?: MarkdownRenderContext,
): { html: string; lineCount: number } | undefined {
  if (start + 1 >= lines.length) return undefined;
  const header = splitTableRow(lines[start] ?? "");
  const delimiter = splitTableRow(lines[start + 1] ?? "");
  if (header.length === 0 || delimiter.length !== header.length) return undefined;

  const alignments: TableAlignment[] = [];
  for (const cell of delimiter) {
    const marker = cell.trim();
    if (!/^:?-+:?$/.test(marker)) return undefined;
    alignments.push(tableAlignment(marker));
  }

  let index = start + 2;
  const rows: string[][] = [];
  while (index < lines.length && (lines[index] ?? "").trim()) {
    const row = splitTableRow(lines[index] ?? "");
    if (row.length === 0) break;
    rows.push(Array.from({ length: header.length }, (_, column) => row[column] ?? ""));
    index += 1;
  }

  const cells = (row: readonly string[], tag: "td" | "th") => row.map((cell, column) => {
    const alignment = alignments[column];
    const className = alignment ? ` class="align-${alignment}"` : "";
    return `<${tag}${className}>${renderInline(cell.trim(), 0, true, context)}</${tag}>`;
  }).join("");
  const body = rows.length > 0
    ? `<tbody>${rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody>`
    : "";
  return {
    html: `<div class="table-scroll"><table><thead><tr>${cells(header, "th")}</tr></thead>${body}</table></div>`,
    lineCount: index - start,
  };
}

function tableAlignment(marker: string): TableAlignment {
  const left = marker.startsWith(":");
  const right = marker.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const source = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const body = source.endsWith("|") ? source.slice(0, -1) : source;
  const cells: string[] = [];
  let cell = "";
  let code = false;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char === "\\" && body[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "`") {
      code = !code;
      cell += char;
    } else if (char === "|" && !code) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function isBlockStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  return Boolean(
    parseFence(line)
    || /^ {0,3}(?:#{1,6}[ \t]+|>|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.test(line)
    || /^ {0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)
    || parseTable(lines, index),
  );
}
