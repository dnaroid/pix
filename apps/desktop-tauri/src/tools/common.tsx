/**
 * Shared utilities and small presentational primitives for tool renderers.
 *
 * Logic ported from src/tool-renderers/utils.ts of the terminal pix where it
 * makes sense, but presentation is React/CSS instead of styled ANSI segments.
 */

import type { ReactNode } from "react";

// -- Argument parsing -----------------------------------------------------

type PlainRecord = Record<string, unknown>;

export function parseArgs(args: unknown): unknown {
  if (args == null) return undefined;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return args;
}

export function argsRecord(args: unknown): PlainRecord | undefined {
  const parsed = parseArgs(args);
  return isPlainRecord(parsed) ? parsed : undefined;
}

export function stringArg(
  args: unknown,
  keys: readonly string[],
): string | undefined {
  const record = argsRecord(args);
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

export function numberArg(
  args: unknown,
  keys: readonly string[],
): number | undefined {
  const record = argsRecord(args);
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

// -- Path display ---------------------------------------------------------

/**
 * Render an absolute path relative to `cwd` when it lies inside it; otherwise
 * return the absolute path unchanged. Mirrors pathForDisplay() in terminal
 * renderers but uses portable string ops (works in browser bundle).
 */
export function pathForDisplay(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  // Only relativize absolute paths that share the cwd's platform style.
  if (!isAbsoluteLike(filePath)) return filePath;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = relativePosix(norm(cwd), norm(filePath));
  if (!rel) return ".";
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    return filePath.replace(/\\/g, "/");
  }
  return rel;
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
}

function relativePosix(from: string, to: string): string {
  if (!to.startsWith(from === "/" ? "/" : from + "/")) return to;
  return to.slice(from.length + 1);
}

// -- Formatting -----------------------------------------------------------

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function compactCommand(command: string | undefined): string | undefined {
  return command ? command.replace(/\s+/g, " ").trim() : undefined;
}

export function formatInline(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === "string") return oneLine(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const preview = value.slice(0, 3).map(formatInline).join(", ");
    return value.length > 3 ? `[${preview}, +${value.length - 3}]` : `[${preview}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    return keys.length === 0
      ? "{}"
      : `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
  }
  return String(value);
}

export function formatHeaderArgs(args: unknown, preferredKeys?: readonly string[]): string {
  if (args == null) return "";
  if (typeof args === "string") return oneLine(args);
  const record = argsRecord(args);
  if (!record) return formatInline(args);
  const entries = Object.entries(record).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  if (preferredKeys && preferredKeys.length > 0) {
    const order = new Map(preferredKeys.map((k, i) => [k, i] as const));
    entries.sort(
      ([l], [r]) =>
        (order.get(l) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(r) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return entries.map(([k, v]) => `${k}: ${formatInline(v)}`).join(" · ");
}

// -- Patch summary --------------------------------------------------------

/**
 * Return a 1-line summary of a unified diff/patch: file list (up to 3 items,
 * then "+N" overflow). Mirrors summarizePatch() from terminal utils.
 */
export function summarizePatch(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const files = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const match =
      /^(?:\*\*\* (?:Update|Add|Delete) File:\s*|Index:\s+|---\s+(?:a\/)?|\+\+\+\s+(?:b\/)?|diff --git a\/)(.+?)(?:\s|$)/.exec(
        trimmed,
      );
    const file = match?.[1]?.trim();
    if (file && !file.startsWith("/dev/null")) files.add(file.replace(/^[ab]\//, ""));
  }
  if (files.size === 0) return undefined;
  const list = [...files];
  const shown = list.slice(0, 3).join(", ");
  return list.length > 3 ? `${shown}, +${list.length - 3}` : shown;
}

export function isGitDiffCommand(command: string): boolean {
  return /(?:^|[;&|()]\s*)git\b[^;&|()]*\bdiff\b/.test(command);
}

// -- Helpers --------------------------------------------------------------

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -- Output helpers -------------------------------------------------------

/** Coerce a result value into a string for display bodies. */
export function resultText(result: unknown, status: ToolStatusLike): string {
  if (typeof result === "string") return result;
  if (result == null) return status === "running" ? "running…" : "(empty)";
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

type ToolStatusLike = "running" | "done" | "error";

// -- Small React primitives ----------------------------------------------

export function CodeBlock({
  children,
  language,
}: {
  children: string;
  language?: string;
}): ReactNode {
  return (
    <pre className={`tool__code${language ? ` tool__code--${language}` : ""}`}>
      {children}
    </pre>
  );
}

export function DiffBlock({ children }: { children: string }): ReactNode {
  const lines = children.split("\n");
  return (
    <pre className="tool__diff">
      {lines.map((line, i) => {
        const cls =
          line.startsWith("+") && !line.startsWith("+++")
            ? "tool__diff-line tool__diff-line--add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "tool__diff-line tool__diff-line--del"
              : line.startsWith("@@")
                ? "tool__diff-line tool__diff-line--hunk"
                : "tool__diff-line";
        return (
          <span key={i} className={cls}>
            {line || "\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="tool__section">
      <div className="tool__section-label">{label}</div>
      <div className="tool__section-body">{children}</div>
    </div>
  );
}
