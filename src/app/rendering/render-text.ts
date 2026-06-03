import { createHash } from "node:crypto";
import { wrapDisplayLine } from "../../terminal-width.js";
import type { Theme } from "../../theme.js";
import { APP_ICONS } from "../icons.js";
import { horizontalPaddingLayout, padOrTrimPlain, sanitizeText } from "../text-format.js";
import type { ToolStatusEntry } from "../types.js";

export { ellipsizeDisplay, horizontalPaddingLayout, normalizePastedTextForDuplicateKey, padOrTrimPlain, sanitizeText } from "../text-format.js";

const LSP_DIAGNOSTIC_ICON = "\u{f0026}";

export function alertIconPrefixLength(text: string): number | undefined {
	if (text.startsWith(APP_ICONS.alert)) return APP_ICONS.alert.length;
	if (text.startsWith(LSP_DIAGNOSTIC_ICON)) return LSP_DIAGNOSTIC_ICON.length;
	return /^⚠️?/u.exec(text)?.[0].length;
}

export function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function hasLspDiagnosticsAfterMutation(output: string): boolean {
	return /lsp\s+(?:errors?|warnings?|diagnostics?)\s+after\s+mutation/i.test(output) || /lsp\s+diagnostics\s*:/i.test(output);
}

const LSP_DIAGNOSTIC_MUTATION_TOOLS = new Set(["apply_patch", "ast_apply"]);

export function hasToolLspDiagnosticsAfterMutation(entry: ToolStatusEntry): boolean {
	return LSP_DIAGNOSTIC_MUTATION_TOOLS.has(entry.toolName.toLowerCase()) && hasLspDiagnosticsAfterMutation(entry.output);
}

export function lspDiagnosticSeverityForLine(line: string): "error" | "warning" | "hint" | undefined {
	const counts = lspDiagnosticCounts(line);
	const countSeverity = lspDiagnosticCountSeverity(counts);
	if (countSeverity) return countSeverity;
	if (counts.length > 0) return undefined;

	const severityMatch = /(?:^|[^\p{L}\p{N}_])(?:diagnosticseverity\.)?(errors?|warnings?|warn|hints?)(?=$|[^\p{L}\p{N}_])/iu.exec(line);
	const severity = severityMatch?.[1]?.toLowerCase();
	if (!severity) return undefined;
	if (severity.startsWith("error")) return "error";
	if (severity.startsWith("warn")) return "warning";
	return "hint";
}

function lspDiagnosticCounts(line: string): RegExpMatchArray[] {
	return [...line.matchAll(/\b(\d+)\s+(errors?|warnings?|hints?)\b/giu)];
}

function lspDiagnosticCountSeverity(counts: RegExpMatchArray[]): "error" | "warning" | "hint" | undefined {
	for (const severity of ["error", "warning", "hint"] as const) {
		if (counts.some((match) => Number(match[1]) > 0 && match[2]?.toLowerCase().startsWith(severity))) return severity;
	}
	return undefined;
}

export function toolLspDiagnosticsAfterMutationSeverity(entry: ToolStatusEntry): "error" | "warning" | undefined {
	if (!hasToolLspDiagnosticsAfterMutation(entry)) return undefined;
	if (/\blsp\s+errors?\s+after\s+mutation\b/i.test(entry.output)) return "error";

	const diagnosticLines = entry.output.split("\n").map((line) => line.trim());
	if (diagnosticLines.some((line) => lspDiagnosticSeverityForLine(line) === "error")) return "error";
	return "warning";
}

export function toolStatusIcon(entry: ToolStatusEntry): string {
	if (entry.status === "running") return APP_ICONS.timerSand;
	if (entry.isError) return APP_ICONS.closeCircle;
	if (toolLspDiagnosticsAfterMutationSeverity(entry)) return APP_ICONS.alert;
	return APP_ICONS.checkCircle;
}

export function toolStatusIconColor(entry: ToolStatusEntry, colors: Theme["colors"]): string {
	if (entry.status === "running") return colors.muted;
	if (entry.isError) return colors.error;
	const lspSeverity = toolLspDiagnosticsAfterMutationSeverity(entry);
	if (lspSeverity === "error") return colors.error;
	if (lspSeverity === "warning") return colors.warning;
	return colors.success;
}

export function wrapLine(text: string, width: number): string[] {
	return wrapDisplayLine(text, width);
}

export function wrapText(text: string, width: number): string[] {
	const lines = sanitizeText(text).split("\n");
	return lines.flatMap((line) => wrapLine(line, width));
}

export function padHorizontalText(text: string, width: number): string {
	const { left, right, contentWidth } = horizontalPaddingLayout(width);
	return `${" ".repeat(left)}${padOrTrimPlain(text, contentWidth)}${" ".repeat(right)}`;
}
