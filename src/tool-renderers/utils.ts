import type { ToolBodyLineStyle, ToolRenderInput, ToolRenderResult } from "./types.js";

type PlainRecord = Record<string, unknown>;

export function normalizeToolName(toolName: string): string {
	const lastPart = toolName.split(/[.:/]/).filter(Boolean).at(-1) ?? toolName;
	return lastPart.trim();
}

export function parseArgsText(argsText: string): unknown {
	const trimmed = argsText.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return trimmed;
	}
}

export function argsRecord(input: ToolRenderInput): PlainRecord | undefined {
	const parsed = parseArgsText(input.argsText);
	return isPlainRecord(parsed) ? parsed : undefined;
}

export function stringArg(input: ToolRenderInput, keys: readonly string[]): string | undefined {
	const record = argsRecord(input);
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" || typeof value === "boolean") return String(value);
	}
	return undefined;
}

export function numberArg(input: ToolRenderInput, keys: readonly string[]): number | undefined {
	const record = argsRecord(input);
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export function defaultToolRender(input: ToolRenderInput): ToolRenderResult {
	const args = parseArgsText(input.argsText);
	const argsInline = formatArgsInline(args);
	const argsBlock = formatArgsBlock(args);
	const expanded = argsAndResultExpandedText(input, argsBlock);
	return {
		headerArgs: argsInline,
		collapsedBody: input.output || argsBlock,
		...expanded,
	};
}

export function renderWithArgsAndResult(
	input: ToolRenderInput,
	options: {
		headerArgs?: string | undefined;
		argumentsBody?: string | undefined;
		collapsedBody?: string | undefined;
	} = {},
): ToolRenderResult {
	const args = parseArgsText(input.argsText);
	const argsBlock = options.argumentsBody ?? formatArgsBlock(args);
	const expanded = argsAndResultExpandedText(input, argsBlock);
	return {
		headerArgs: options.headerArgs ?? formatArgsInline(args),
		collapsedBody: (options.collapsedBody ?? input.output) || argsBlock,
		...expanded,
	};
}

export function resultSection(input: ToolRenderInput): string {
	if (input.output) return input.isError ? labeledBlock("error", input.output) : input.output;
	return input.status === "running" ? "running…" : "(empty)";
}

export function argsAndResultExpandedText(input: ToolRenderInput, argsBlock: string): Pick<ToolRenderResult, "expandedText" | "bodyLineStyles"> {
	const formattedArgs = argsBlock.trimEnd();
	const showArgs = formattedArgs.length > 0 && formattedArgs !== "(empty)";
	return expandedTextFromParts(
		...(showArgs ? [{ text: formattedArgs }] : []),
		{ text: resultText(input, { empty: !showArgs }) },
	);
}

export function resultText(input: ToolRenderInput, options: { empty?: boolean } = {}): string {
	if (input.output) return input.isError ? labeledBlock("error", input.output) : input.output;
	if (input.status === "running") return "running…";
	return options.empty === false ? "" : "(empty)";
}

export function expandedTextFromParts(...parts: readonly ExpandedTextPart[]): Pick<ToolRenderResult, "expandedText" | "bodyLineStyles"> {
	const textParts: string[] = [];
	const bodyLineStyles: ToolBodyLineStyle[] = [];
	let startLine = 0;

	for (const part of parts) {
		const text = part.text?.trimEnd();
		if (!text) continue;
		if (textParts.length > 0) startLine += 1;
		textParts.push(text);

		const partLines = lineCount(text);
		if (part.color || part.foreground || part.bold || part.underline || part.strikethrough) {
			bodyLineStyles.push({
				startLine,
				endLine: startLine + partLines,
				...(part.color ? { color: part.color } : {}),
				...(part.foreground ? { foreground: part.foreground } : {}),
				...(part.bold != null ? { bold: part.bold } : {}),
				...(part.underline != null ? { underline: part.underline } : {}),
				...(part.strikethrough != null ? { strikethrough: part.strikethrough } : {}),
			});
		}
		startLine += partLines;
	}

	return {
		expandedText: joinSections(...textParts),
		...(bodyLineStyles.length > 0 ? { bodyLineStyles } : {}),
	};
}

export function labeledBlock(title: string, body: string | undefined): string {
	const content = body?.trimEnd();
	return content ? `${title}\n${content}` : "";
}

export function joinSections(...parts: readonly string[]): string {
	const joined = parts.filter((part) => part.trim()).join("\n\n");
	return joined || "(empty)";
}

export function indent(text: string, spaces = 2): string {
	const prefix = " ".repeat(spaces);
	return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

export function lineCount(text: string): number {
	return text.split("\n").length;
}

type ExpandedTextPart = {
	text?: string | undefined;
} & Omit<ToolBodyLineStyle, "startLine" | "endLine">;

export function formatArgsInline(args: unknown, preferredKeys?: readonly string[]): string {
	if (args == null) return "";
	if (typeof args === "string") return oneLine(args);
	if (!isPlainRecord(args)) return formatInlineValue(args);

	const entries = orderedEntries(args, preferredKeys);
	return entries.map(([key, value]) => `${key}: ${formatInlineValue(value)}`).join(" · ");
}

export function formatArgsBlock(args: unknown, preferredKeys?: readonly string[]): string {
	if (args == null) return "(empty)";
	if (typeof args === "string") return args;
	if (!isPlainRecord(args)) return formatBlockValue(args, 0);

	const entries = orderedEntries(args, preferredKeys);
	if (entries.length === 0) return "(empty)";
	return entries.map(([key, value]) => formatRecordEntry(key, value, 0)).join("\n");
}

export function summarizePatch(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const files = new Set<string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		const match = /^(?:\*\*\* (?:Update|Add|Delete) File:\s*|Index:\s+|---\s+(?:a\/)?|\+\+\+\s+(?:b\/)?|diff --git a\/)(.+?)(?:\s|$)/.exec(trimmed);
		const file = match?.[1]?.trim();
		if (file && !file.startsWith("/dev/null")) files.add(file.replace(/^[ab]\//, ""));
	}
	if (files.size === 0) return undefined;
	const list = [...files];
	const shown = list.slice(0, 3).join(", ");
	return list.length > 3 ? `${shown}, +${list.length - 3}` : shown;
}

export function compactCommand(command: string | undefined): string | undefined {
	return command ? command.replace(/\s+/g, " ").trim() : undefined;
}

function orderedEntries(record: PlainRecord, preferredKeys: readonly string[] | undefined): [string, unknown][] {
	const entries = Object.entries(record).filter(([, value]) => value !== undefined);
	if (!preferredKeys || preferredKeys.length === 0) return entries;
	const order = new Map(preferredKeys.map((key, index) => [key, index]));
	return entries.sort(([left], [right]) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
}

function formatRecordEntry(key: string, value: unknown, depth: number): string {
	if (isPlainRecord(value) || Array.isArray(value)) {
		return `${key}:\n${indent(formatBlockValue(value, depth + 1))}`;
	}
	return `${key}: ${formatBlockValue(value, depth)}`;
}

function formatBlockValue(value: unknown, depth: number): string {
	if (value == null) return String(value);
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		if (depth >= 2) return `[${value.length} items]`;
		return value.map((item) => `- ${formatBlockValue(item, depth + 1).replace(/\n/g, "\n  ")}`).join("\n");
	}
	if (isPlainRecord(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) return "{}";
		if (depth >= 2) return `{${entries.map(([key]) => key).join(", ")}}`;
		return entries.map(([key, nested]) => formatRecordEntry(key, nested, depth + 1)).join("\n");
	}
	return String(value);
}

function formatInlineValue(value: unknown): string {
	if (value == null) return String(value);
	if (typeof value === "string") return oneLine(value);
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const preview = value.slice(0, 3).map(formatInlineValue).join(", ");
		return value.length > 3 ? `[${preview}, +${value.length - 3}]` : `[${preview}]`;
	}
	if (isPlainRecord(value)) {
		const keys = Object.keys(value);
		return keys.length === 0 ? "{}" : `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
	}
	return String(value);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function isPlainRecord(value: unknown): value is PlainRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
