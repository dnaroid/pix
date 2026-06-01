import type { Diagnostic } from "vscode-languageserver-protocol";

interface TsserverLocation {
  line?: number;
  offset?: number;
}

interface TsserverDiagnostic {
  start?: number | TsserverLocation;
  end?: TsserverLocation;
  length?: number;
  text?: unknown;
  message?: unknown;
  code?: string | number;
  category?: string | number;
  source?: string;
}

interface TsserverResponse {
  success?: boolean;
  message?: string;
  body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tsserverMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return value === undefined ? "TypeScript diagnostic" : String(value);

  const messageText = tsserverMessageText(value.messageText);
  const next = Array.isArray(value.next) ? value.next.map(tsserverMessageText).filter((item) => item.trim().length > 0) : [];
  return [messageText, ...next.map((item) => `  ${item}`)].filter((item) => item.trim().length > 0).join("\n");
}

function isTsserverDiagnostic(value: unknown): value is TsserverDiagnostic {
  return isRecord(value) && ("text" in value || "message" in value || "code" in value);
}

export function tsserverDiagnosticsFromResponse(value: unknown): TsserverDiagnostic[] {
  const response = isRecord(value) ? value as TsserverResponse : undefined;
  if (response?.success === false) throw new Error(response.message ?? "tsserver request failed");

  const body = response && "body" in response ? response.body : value;
  if (!Array.isArray(body)) return [];
  return body.filter(isTsserverDiagnostic);
}

function tsserverCategoryToSeverity(category: string | number | undefined): NonNullable<Diagnostic["severity"]> {
  if (category === "error" || category === 1) return 1;
  if (category === "warning" || category === 0) return 2;
  if (category === "message" || category === 3) return 3;
  if (category === "suggestion" || category === 2) return 4;
  return 1;
}

function positionAtOffset(text: string, offset: number): { line: number; character: number } {
  const safeOffset = Math.max(0, Math.min(text.length, offset));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < safeOffset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, character: safeOffset - lineStart };
}

function tsserverLocationToPosition(location: TsserverLocation | undefined): { line: number; character: number } | undefined {
  if (typeof location?.line !== "number" || typeof location.offset !== "number") return undefined;
  return {
    line: Math.max(0, location.line - 1),
    character: Math.max(0, location.offset - 1),
  };
}

function tsserverDiagnosticRange(diagnostic: TsserverDiagnostic, text: string): Diagnostic["range"] {
  if (isRecord(diagnostic.start)) {
    const start = tsserverLocationToPosition(diagnostic.start);
    if (start) return { start, end: tsserverLocationToPosition(diagnostic.end) ?? start };
  }

  if (typeof diagnostic.start === "number") {
    const startOffset = Math.max(0, diagnostic.start - 1);
    const length = typeof diagnostic.length === "number" ? Math.max(0, diagnostic.length) : 0;
    return {
      start: positionAtOffset(text, startOffset),
      end: positionAtOffset(text, startOffset + length),
    };
  }

  const start = { line: 0, character: 0 };
  return { start, end: start };
}

export function tsserverDiagnosticToLsp(diagnostic: TsserverDiagnostic, text: string): Diagnostic {
  return {
    range: tsserverDiagnosticRange(diagnostic, text),
    severity: tsserverCategoryToSeverity(diagnostic.category),
    source: diagnostic.source ?? "typescript",
    message: tsserverMessageText(diagnostic.text ?? diagnostic.message),
    code: diagnostic.code,
  };
}
