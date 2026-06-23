import type { ToolRenderInput, ToolRenderResult } from "./types.js";
import type { ToolBodySyntaxHighlight, ToolBodySyntaxHighlights } from "../syntax-highlight.js";
import { argsRecord, compactCommand, expandedTextFromParts, lineCount, resultText, stringArg } from "./utils.js";

const SKILL_TOOL_NAME = "skill";
const SKILL_FILE_RE = /(?:^|[\\/])SKILL\.md$/i;
const SHELL_SKILL_FILE_RE = /(?:^|[\s'"`=:[\\/])SKILL\.md(?:$|[\s'"`;|&)>),:])/i;
const SHELL_SKILL_PATH_RE = /(?:^|[\s'"`=:[(])([^\s'"`;|&)>),]+SKILL\.md)(?=$|[\s'"`;|&)>),:])/i;
const READ_COMMAND_RE = /(?:^|[;&|()\s])(?:cat|bat|batcat|less|more|head|tail|sed|awk|grep|rg|ripgrep|nl|wc|file)\b/i;
const MUTATING_SKILL_COMMAND_RE = /(?:>\s*|>>\s*|tee\b[^\n;&|]*|sed\b[^\n;&|]*\s-i(?:\b|[A-Za-z]))[^\n;&|]*SKILL\.md/i;

type SkillReadInfo = {
	path?: string;
	name: string;
};

export function applySkillReadDisplay(input: ToolRenderInput, rendered: ToolRenderResult): ToolRenderResult {
	const skill = skillReadInfo(input);
	if (!skill) return rendered;
	const pathText = skill.path ?? "";
	const expanded = expandedTextFromParts(
		{ text: pathText },
		{ text: resultText(input, { empty: !pathText }) },
	);
	const resultStartLine = pathText ? lineCount(pathText) + 1 : 0;

	return {
		...rendered,
		toolName: SKILL_TOOL_NAME,
		headerArgs: skill.name,
		syntaxHighlight: input.output && !input.isError ? skillSyntaxHighlight(input.output, resultStartLine) : undefined,
		...expanded,
	};
}

function skillSyntaxHighlight(output: string, resultStartLine: number): ToolBodySyntaxHighlights {
	const frontmatterLineCount = yamlFrontmatterLineCount(output);
	if (frontmatterLineCount === 0) return { language: "markdown", startLine: resultStartLine, startColumn: 0 };

	const yamlHighlight: ToolBodySyntaxHighlight = {
		language: "yaml",
		startLine: resultStartLine,
		endLine: resultStartLine + frontmatterLineCount,
		startColumn: 0,
	};
	const markdownHighlight: ToolBodySyntaxHighlight = {
		language: "markdown",
		startLine: resultStartLine + frontmatterLineCount,
		startColumn: 0,
	};
	return [yamlHighlight, markdownHighlight];
}

function yamlFrontmatterLineCount(output: string): number {
	const lines = output.split("\n");
	if (lines[0]?.trim() !== "---") return 0;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---") return index + 1;
	}
	return 0;
}

function skillReadInfo(input: ToolRenderInput): SkillReadInfo | undefined {
	let path: string | undefined;
	if (isShellTool(input.toolName)) {
		path = shellSkillPath(input);
	} else if (isReadTool(input.toolName)) {
		path = skillPathArgument(input);
	}
	if (!path) return undefined;

	return {
		path,
		name: skillNameFromPath(path, shellWorkingDirectory(input)),
	};
}

function isShellTool(toolName: string): boolean {
	const normalized = toolName.split(/[.:/]/).filter(Boolean).at(-1) ?? toolName;
	return ["bash", "Bash", "shell", "shell_command"].includes(normalized);
}

function isReadTool(toolName: string): boolean {
	const normalized = toolName.split(/[.:/]/).filter(Boolean).at(-1) ?? toolName;
	return normalized.toLowerCase() === "read";
}

function shellSkillPath(input: ToolRenderInput): string | undefined {
	const command = compactCommand(stringArg(input, ["command", "cmd", "script"]));
	if (!command || !SHELL_SKILL_FILE_RE.test(command) || !READ_COMMAND_RE.test(command)) return undefined;
	if (MUTATING_SKILL_COMMAND_RE.test(command)) return undefined;
	return SHELL_SKILL_PATH_RE.exec(command)?.[1] ?? "SKILL.md";
}

function skillPathArgument(input: ToolRenderInput): string | undefined {
	const record = argsRecord(input);
	if (!record) return undefined;

	for (const [key, value] of Object.entries(record)) {
		if (!isPathLikeKey(key)) continue;
		const path = findSkillPath(value);
		if (path) return path;
	}

	return undefined;
}

function isPathLikeKey(key: string): boolean {
	return /(?:path|file|target|url|uri|glob|cwd|workdir|directory|dir)s?$/i.test(key);
}

function findSkillPath(value: unknown): string | undefined {
	if (typeof value === "string") {
		const path = value.trim();
		return SKILL_FILE_RE.test(path) ? path : undefined;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const path = findSkillPath(item);
			if (path) return path;
		}
		return undefined;
	}
	if (typeof value === "object" && value !== null) {
		for (const nested of Object.values(value)) {
			const path = findSkillPath(nested);
			if (path) return path;
		}
	}
	return undefined;
}

function skillNameFromPath(path: string, cwd: string | undefined): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalized.split("/").filter(Boolean);
	const fileName = parts.at(-1);
	const parentName = fileName?.toLowerCase() === "skill.md" ? parts.at(-2) : undefined;
	if (parentName) return parentName;
	if (cwd) return cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? "skill";
	return "skill";
}

function shellWorkingDirectory(input: ToolRenderInput): string | undefined {
	return stringArg(input, ["cwd", "workdir"]);
}
