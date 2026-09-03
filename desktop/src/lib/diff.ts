export type DiffLineKind = "context" | "added" | "removed" | "hunk" | "meta";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface ToolDiff {
  readonly path: string;
  readonly oldText?: string | null;
  readonly newText: string;
}

export interface DiffViewModel {
  readonly path?: string;
  readonly lines: readonly DiffLine[];
  readonly additions: number;
  readonly deletions: number;
}

type DiffOperation = { readonly kind: "context" | "added" | "removed"; readonly text: string };

const MAX_LCS_CELLS = 160_000;

/** Build a compact line diff from ACP's structured old/new text payload. */
export function structuredDiffModel(diff: ToolDiff): DiffViewModel {
  const oldLines = textLines(diff.oldText ?? "");
  const newLines = textLines(diff.newText);
  const operations = diff.oldText == null
    ? newLines.map((text): DiffOperation => ({ kind: "added", text }))
    : diffLines(oldLines, newLines);

  return {
    path: diff.path,
    lines: operations.map((operation) => ({ kind: operation.kind, text: marker(operation.kind) + operation.text })),
    additions: operations.filter((operation) => operation.kind === "added").length,
    deletions: operations.filter((operation) => operation.kind === "removed").length,
  };
}

/** Parse unified/apply-patch text while preserving the original display lines. */
export function unifiedDiffModel(text: string): DiffViewModel {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let additions = 0;
  let deletions = 0;
  const lines: DiffLine[] = [];

  for (const rawLine of textLines(stripAnsi(text))) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(rawLine);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] ?? "0", 10);
      newLine = Number.parseInt(hunk[2] ?? "0", 10);
      lines.push({ kind: "hunk", text: rawLine });
      continue;
    }

    const kind = unifiedDiffLineKind(rawLine);
    if (kind === "added") {
      additions += 1;
      lines.push({ kind, text: rawLine, ...(newLine === undefined ? {} : { newLine }) });
      if (newLine !== undefined) newLine += 1;
    } else if (kind === "removed") {
      deletions += 1;
      lines.push({ kind, text: rawLine, ...(oldLine === undefined ? {} : { oldLine }) });
      if (oldLine !== undefined) oldLine += 1;
    } else if (kind === "context") {
      lines.push({
        kind,
        text: rawLine,
        ...(oldLine === undefined ? {} : { oldLine }),
        ...(newLine === undefined ? {} : { newLine }),
      });
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
    } else {
      lines.push({ kind, text: rawLine });
    }
  }

  return { lines, additions, deletions };
}

/** Match the same shell command class that the TUI renders as a diff. */
export function isShellDiffTool(kind: string, title: string): boolean {
  if (kind !== "execute") return false;
  const command = title.replace(/^(?:bash|shell)(?::|\s)\s*/i, "");
  return /(?:^|[;&|()]\s*)git\b[^;&|()]*\bdiff\b/.test(command);
}

export function unifiedDiffLineKind(line: string): DiffLineKind {
  if (/^@@/.test(line)) return "hunk";
  if (/^(?:diff --git|index |---|\+\+\+|\*\*\* (?:Begin|End|Update|Add|Delete) (?:Patch|File:)|\\ No newline)/.test(line)) {
    return "meta";
  }
  // Markers only count in column zero. Indented Markdown bullets are context.
  if (/^\+/.test(line)) return "added";
  if (/^-/.test(line)) return "removed";
  return "context";
}

function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffOperation[] {
  if (oldLines.length === 0) return newLines.map((text) => ({ kind: "added", text }));
  if (newLines.length === 0) return oldLines.map((text) => ({ kind: "removed", text }));

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return boundedDiff(oldLines, newLines);
  }

  const matrix = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(newLines.length + 1),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex]![newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? (matrix[oldIndex + 1]?.[newIndex + 1] ?? 0) + 1
        : Math.max(matrix[oldIndex + 1]?.[newIndex] ?? 0, matrix[oldIndex]?.[newIndex + 1] ?? 0);
    }
  }

  const operations: DiffOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    const oldText = oldLines[oldIndex] ?? "";
    const newText = newLines[newIndex] ?? "";
    if (oldText === newText) {
      operations.push({ kind: "context", text: oldText });
      oldIndex += 1;
      newIndex += 1;
    } else if ((matrix[oldIndex + 1]?.[newIndex] ?? 0) >= (matrix[oldIndex]?.[newIndex + 1] ?? 0)) {
      operations.push({ kind: "removed", text: oldText });
      oldIndex += 1;
    } else {
      operations.push({ kind: "added", text: newText });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) operations.push({ kind: "removed", text: oldLines[oldIndex++] ?? "" });
  while (newIndex < newLines.length) operations.push({ kind: "added", text: newLines[newIndex++] ?? "" });
  return operations;
}

/** Avoid quadratic work for whole-file writes while retaining obvious context. */
function boundedDiff(oldLines: readonly string[], newLines: readonly string[]): DiffOperation[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1;

  return [
    ...oldLines.slice(0, prefix).map((text): DiffOperation => ({ kind: "context", text })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((text): DiffOperation => ({ kind: "removed", text })),
    ...newLines.slice(prefix, newLines.length - suffix).map((text): DiffOperation => ({ kind: "added", text })),
    ...oldLines.slice(oldLines.length - suffix).map((text): DiffOperation => ({ kind: "context", text })),
  ];
}

function marker(kind: DiffOperation["kind"]): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "-";
  return " ";
}

function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}
