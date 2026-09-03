import { structuredDiffModel, unifiedDiffModel, type DiffViewModel, type ToolDiff } from "./diff";
import type { ToolItem } from "./transcript";

export type ToolAttention = "error" | "warning";
export type ToolOutputLineTone = "default" | "error" | "warning" | "hint" | "success" | "label";

export interface ToolDiffPresentation {
  readonly model: DiffViewModel;
  readonly label?: string;
}

export interface ToolOutputLine {
  readonly text: string;
  readonly tone: ToolOutputLineTone;
}

const MUTATION_TOOLS = new Set(["apply_patch", "ast_apply", "edit", "multiedit", "write"]);

export function mutationDiffPresentations(tool: ToolItem): ToolDiffPresentation[] {
  if (tool.status !== "completed") return [];

  const name = normalizedToolName(tool);
  if (name === "edit" || name === "multiedit") {
    const resultPatch = patchText(tool.rawOutput);
    if (resultPatch) return [{ model: unifiedDiffModel(resultPatch), label: tool.path ?? name }];
  }
  if (tool.diffs.length > 0) return tool.diffs.map(structuredDiffPresentation);

  const input = asRecord(tool.rawInput);
  if (name === "edit" || name === "multiedit") {
    return editDiffs(input, tool.path).map(structuredDiffPresentation);
  }
  if (name === "write") {
    const path = outputPath(input, tool.path);
    const content = input?.content;
    return path && typeof content === "string"
      ? [structuredDiffPresentation({ path, newText: content })]
      : [];
  }
  if (name === "apply_patch") {
    const patch = patchText(tool.rawInput) ?? patchText(tool.rawOutput);
    return patch ? [{ model: unifiedDiffModel(patch), label: "apply_patch" }] : [];
  }
  return [];
}

export function isMutationTool(tool: Pick<ToolItem, "kind" | "name" | "title">): boolean {
  return MUTATION_TOOLS.has(normalizedToolName(tool)) || tool.kind === "edit";
}

export function toolLspAttention(tool: Pick<ToolItem, "content" | "kind" | "name" | "status" | "title">): ToolAttention | undefined {
  if (tool.status !== "completed" || !isMutationTool(tool) || !hasLspDiagnostics(tool.content)) return undefined;
  if (/\blsp\s+errors?\s+after\s+mutation\b/i.test(tool.content)) return "error";
  return tool.content.split("\n").some((line) => lspDiagnosticSeverity(line) === "error") ? "error" : "warning";
}

export function toolGroupAttention(tools: readonly ToolItem[]): ToolAttention | undefined {
  const attentions = tools.map(toolLspAttention);
  if (attentions.includes("error")) return "error";
  return attentions.includes("warning") ? "warning" : undefined;
}

export function mutationOutputLines(content: string): ToolOutputLine[] {
  let inLspSection = false;
  let inCommentChecker = false;
  return content.replace(/\r/g, "").split("\n").map((text) => {
    if (/lsp\s+(?:errors?|warnings?|diagnostics?)\s+after\s+mutation/i.test(text) || /lsp\s+diagnostics\s*:/i.test(text)) {
      inLspSection = true;
      inCommentChecker = false;
      return { text, tone: "label" };
    }
    if (/comment-checker/i.test(text)) {
      inLspSection = false;
      inCommentChecker = true;
      return { text, tone: "warning" };
    }
    if (inCommentChecker) {
      const tone = text.trim() ? "warning" : "default";
      if (text.trim() === "---") inCommentChecker = false;
      return { text, tone };
    }
    if (!inLspSection) return { text, tone: "default" };

    const severity = lspDiagnosticSeverity(text);
    if (severity) return { text, tone: severity };
    if (/✅|\bno diagnostics\b/i.test(text)) return { text, tone: "success" };
    if (alertIconPrefixLength(text) !== undefined) return { text, tone: "warning" };
    return { text, tone: "default" };
  });
}

function structuredDiffPresentation(diff: ToolDiff): ToolDiffPresentation {
  return { model: structuredDiffModel(diff) };
}

function editDiffs(input: Record<string, unknown> | undefined, fallbackPath: string | undefined): ToolDiff[] {
  const path = outputPath(input, fallbackPath);
  if (!path || !input) return [];

  const oldText = input.old_string ?? input.oldText;
  const newText = input.new_string ?? input.newText;
  if (typeof oldText === "string" && typeof newText === "string") return [{ path, oldText, newText }];

  if (!Array.isArray(input.edits)) return [];
  return input.edits.flatMap((value) => {
    const edit = asRecord(value);
    const oldText = edit?.oldText ?? edit?.old_string;
    const newText = edit?.newText ?? edit?.new_string;
    return typeof oldText === "string" && typeof newText === "string"
      ? [{ path, oldText, newText }]
      : [];
  });
}

function outputPath(input: Record<string, unknown> | undefined, fallback: string | undefined): string | undefined {
  if (fallback) return fallback;
  const path = input?.path ?? input?.file_path ?? input?.filePath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function patchText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["input", "patch"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function normalizedToolName(tool: Pick<ToolItem, "name" | "title">): string {
  const raw = tool.name ?? tool.title.split(/[:\s]/, 1)[0] ?? "";
  return (raw.split(/[.:/]/).filter(Boolean).at(-1) ?? raw).trim().toLowerCase();
}

function hasLspDiagnostics(content: string): boolean {
  return /lsp\s+(?:errors?|warnings?|diagnostics?)\s+after\s+mutation/i.test(content) || /lsp\s+diagnostics\s*:/i.test(content);
}

function lspDiagnosticSeverity(line: string): "error" | "warning" | "hint" | undefined {
  const counts = [...line.matchAll(/\b(\d+)\s+(errors?|warnings?|hints?)\b/giu)];
  for (const severity of ["error", "warning", "hint"] as const) {
    if (counts.some((match) => Number(match[1]) > 0 && match[2]?.toLowerCase().startsWith(severity))) return severity;
  }
  if (counts.length > 0) return undefined;

  const match = /(?:^|[^\p{L}\p{N}_])(?:diagnosticseverity\.)?(errors?|warnings?|warn|hints?)(?=$|[^\p{L}\p{N}_])/iu.exec(line);
  const severity = match?.[1]?.toLowerCase();
  if (!severity) return undefined;
  if (severity.startsWith("error")) return "error";
  if (severity.startsWith("warn")) return "warning";
  return "hint";
}

function alertIconPrefixLength(text: string): number | undefined {
  if (text.startsWith("󰀦")) return "󰀦".length;
  return /^⚠️?/u.exec(text)?.[0].length;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
