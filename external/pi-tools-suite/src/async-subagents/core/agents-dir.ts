import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Project-local sub-agent definitions from `.pi/agents/*.md`.
 *
 * Each Markdown file defines one sub-agent type (Claude Code `.claude/agents`
 * style): a YAML frontmatter subset for the `SubagentTypeConfig` fields plus a
 * markdown body that becomes `promptAppend`. The type name comes from the
 * filename (without `.md`).
 *
 * This module only discovers and parses; field normalization happens in
 * config.ts via `normalizeSubagentTypeProfile` so JSONC and markdown sources
 * apply identical validation. There is intentionally no caching: callers load
 * definitions on every config read so edits (and `/reload`) take effect on the
 * next spawn without a restart.
 *
 * Supported frontmatter YAML subset (bounded, dependency-free):
 * - `key: value` scalars: plain, single/double-quoted strings, numbers, booleans
 * - `#` comments (full-line and trailing)
 * - inline arrays: `[a, b, "c"]`
 * - block lists: `- item` (indented or at the parent key's indent)
 * - one+ levels of nested maps for `modelByParent` / `retry`
 * - comma-separated strings for array fields (`tools: read, grep, bash`)
 *
 * Anything else (tabs, block scalars `|`/`>`, anchors/aliases, flow maps,
 * multi-document markers, list-item maps) is a hard error naming file and line.
 */

export interface AgentDefinition {
	/** Raw type profile fields; normalized later by config.ts. */
	raw: Record<string, unknown>;
	/** Absolute path of the source .md file (used in error messages). */
	file: string;
}

/** Backwards-compatible name for project-local definitions. */
export type ProjectAgentDefinition = AgentDefinition;

/** Keys allowed in agent frontmatter. `name` is a filename-consistency check. */
const KNOWN_FRONTMATTER_KEYS = new Set([
	"name",
	"description",
	"icon",
	"models",
	"model",
	"fallbackModels",
	"modelByParent",
	"thinking",
	"tools",
	"isolatedSkills",
	"extraArgs",
	"promptAppend",
	"promptOverride",
	"retry",
	"maxResultBytes",
	"timeoutMs",
]);

/** String fields whose comma-separated form expands to an array. */
const COMMA_SEPARATED_ARRAY_KEYS = new Set([
	"tools",
	"models",
	"fallbackModels",
	"isolatedSkills",
	"extraArgs",
	"retryableExitCodes",
]);

const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const NUMERIC_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Discover and parse `.pi/agents/*.md` for the project containing `cwd`. */
export function readProjectAgentDefinitions(cwd: string): Record<string, ProjectAgentDefinition> {
	const dir = findProjectAgentsDir(cwd);
	return dir ? readAgentDefinitionsFromDir(dir) : {};
}

/** Discover and parse top-level `*.md` agent definitions in one directory. */
export function readAgentDefinitionsFromDir(dir: string): Record<string, AgentDefinition> {
	const definitions: Record<string, AgentDefinition> = {};
	for (const file of agentDefinitionFiles(dir)) {
		const name = agentNameFromFilename(path.basename(file), file);
		const raw = parseAgentMarkdownFile(file);
		if (!raw) continue; // no frontmatter: not an agent definition (e.g. README.md)
		definitions[name] = { raw, file };
	}
	return definitions;
}

/**
 * List project agent files: the first `.pi/agents` directory found walking up
 * from `cwd`, its top-level `*.md` files (dotfiles excluded), name-sorted for
 * deterministic merge order.
 */
export function projectAgentDefinitionFiles(cwd: string): string[] {
	const dir = findProjectAgentsDir(cwd);
	return dir ? agentDefinitionFiles(dir) : [];
}

/** Top-level non-dot Markdown files in deterministic filename order. */
export function agentDefinitionFiles(dir: string): string[] {
	if (!isDirectory(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

function findProjectAgentsDir(startDir: string): string | undefined {
	let dir = path.resolve(startDir);
	const root = path.parse(dir).root;
	while (true) {
		const candidate = path.join(dir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		if (dir === root) return undefined;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/** Derive the sub-agent type name from an agent filename; reject invalid names. */
export function agentNameFromFilename(filename: string, file: string): string {
	const name = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
	if (!AGENT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Agent file name "${filename}" is not a valid sub-agent type name (${AGENT_NAME_PATTERN}): ${file}`,
		);
	}
	return name;
}

/**
 * Parse one agent .md file into raw profile fields.
 * Returns undefined when the file has no frontmatter (skipped, not an error).
 * Returns raw fields with the markdown body folded into `promptAppend`.
 */
function parseAgentMarkdownFile(file: string): Record<string, unknown> | undefined {
	const source = fs.readFileSync(file, "utf-8");
	const parsed = parseAgentMarkdown(source, file);
	if (!parsed) return undefined;
	const { frontmatter, body } = parsed;

	if (frontmatter.name !== undefined && frontmatter.name !== path.basename(file, ".md")) {
		throw new Error(
			`Agent frontmatter "name: ${String(frontmatter.name)}" does not match the file name "${path.basename(file, ".md")}": ${file}. Rename the file or remove the "name" key.`,
		);
	}

	const raw: Record<string, unknown> = { ...frontmatter };
	delete raw.name;
	expandCommaSeparatedArrays(raw);
	if (body) {
		raw.promptAppend = typeof raw.promptAppend === "string" && raw.promptAppend.trim()
			? `${raw.promptAppend.trim()}\n\n${body}`
			: body;
	}
	return raw;
}

/** Parse agent markdown source; exported for tests. */
export function parseAgentMarkdown(
	source: string,
	file: string,
): { frontmatter: Record<string, unknown>; body: string } | undefined {
	const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;

	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "---" || line === "...") {
			end = i;
			break;
		}
		if (line === "---" || /^---\s/.test(line)) {
			throw new Error(`Unsupported YAML document separator in agent frontmatter: ${file}:${i + 1}`);
		}
	}
	if (end < 0) {
		throw new Error(`Agent frontmatter is not terminated with "---": ${file}`);
	}

	const frontmatter = parseFrontmatter(lines.slice(1, end), file);
	const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "").trimEnd();
	return { frontmatter, body };
}

interface SourceLine {
	text: string;
	number: number;
	indent: number;
}

function parseFrontmatter(lines: string[], file: string): Record<string, unknown> {
	const sourceLines: SourceLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		if (rawLine.includes("\t")) {
			const leading = rawLine.slice(0, rawLine.search(/\S/));
			if (leading.includes("\t")) {
				throw new Error(`Tabs are not allowed for YAML indentation: ${file}:${i + 1}`);
			}
		}
		const trimmedStart = rawLine.replace(/^ +/, "");
		const indent = rawLine.length - trimmedStart.length;
		sourceLines.push({ text: trimmedStart.replace(/\s+$/, ""), number: i + 2, indent });
	}
	const [value, next] = parseBlock(sourceLines, 0, 0, file);
	if (next < sourceLines.length) {
		const line = sourceLines[next];
		throw new Error(`Unexpected content in agent frontmatter: ${file}:${line.number} ("${line.text}")`);
	}
	if (!isPlainObject(value)) {
		throw new Error(`Agent frontmatter must be a mapping of "key: value" lines: ${file}`);
	}
	for (const key of Object.keys(value)) {
		if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
			throw new Error(
				`Unknown agent frontmatter key "${key}": ${file}. Known keys: ${[...KNOWN_FRONTMATTER_KEYS].sort().join(", ")}.`,
			);
		}
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Skip blank lines and full-line comments. Returns the next meaningful index. */
function skipIgnorable(lines: SourceLine[], start: number): number {
	let i = start;
	while (i < lines.length && (lines[i].text === "" || lines[i].text.startsWith("#"))) i++;
	return i;
}

function isListItem(text: string): boolean {
	return text === "-" || text.startsWith("- ");
}

/** Parse a block (map or list) whose items live at `indent`. Returns [value, nextIndex]. */
function parseBlock(
	lines: SourceLine[],
	start: number,
	indent: number,
	file: string,
): [unknown, number] {
	const first = skipIgnorable(lines, start);
	if (first >= lines.length || lines[first].indent < indent) return [undefined, first];
	if (isListItem(lines[first].text)) return parseList(lines, first, indent, file);
	return parseMap(lines, first, indent, file);
}

function parseMap(
	lines: SourceLine[],
	start: number,
	indent: number,
	file: string,
): [Record<string, unknown>, number] {
	const result: Record<string, unknown> = {};
	let i = start;
	while (true) {
		i = skipIgnorable(lines, i);
		if (i >= lines.length) break;
		const line = lines[i];
		if (line.indent < indent) break;
		if (line.indent > indent) {
			throw new Error(
				`Unexpected indentation in agent frontmatter (expected ${indent}, got ${line.indent}): ${file}:${line.number}`,
			);
		}
		if (isListItem(line.text)) {
			throw new Error(`Unexpected list item in agent frontmatter mapping: ${file}:${line.number}`);
		}

		const { key, rest } = splitKey(line.text, file, line.number);
		if (Object.prototype.hasOwnProperty.call(result, key)) {
			throw new Error(`Duplicate agent frontmatter key "${key}": ${file}:${line.number}`);
		}

		if (rest === "") {
			const peek = skipIgnorable(lines, i + 1);
			if (peek < lines.length && (lines[peek].indent > indent || (lines[peek].indent === indent && isListItem(lines[peek].text)))) {
				const [child, next] = parseBlock(lines, peek, lines[peek].indent, file);
				result[key] = child;
				i = next;
				continue;
			}
			result[key] = undefined;
			i++;
			continue;
		}

		result[key] = parseInlineValue(rest, file, line.number);
		i++;
	}
	return [result, i];
}

function parseList(
	lines: SourceLine[],
	start: number,
	indent: number,
	file: string,
): [unknown[], number] {
	const items: unknown[] = [];
	let i = start;
	while (true) {
		i = skipIgnorable(lines, i);
		if (i >= lines.length) break;
		const line = lines[i];
		if (line.indent < indent || !isListItem(line.text)) break;
		if (line.indent > indent) {
			throw new Error(
				`Unexpected indentation in agent frontmatter list (expected ${indent}, got ${line.indent}): ${file}:${line.number}`,
			);
		}
		const rest = line.text === "-" ? "" : line.text.slice(2);
		if (rest === "") {
			throw new Error(`Nested blocks under list items are not supported: ${file}:${line.number}`);
		}
		if (/^[^'"[][^:]*:(\s|$)/.test(rest) && findTopLevelColon(rest) >= 0) {
			throw new Error(`Map items ("- key: value") are not supported in agent frontmatter lists: ${file}:${line.number}`);
		}
		items.push(parseInlineValue(rest, file, line.number));
		i++;
	}
	return [items, i];
}

/** Split "key: rest" honoring quoted keys; `rest` keeps trailing comments. */
function splitKey(text: string, file: string, lineNumber: number): { key: string; rest: string } {
	if (text.startsWith('"') || text.startsWith("'")) {
		const quote = text[0];
		const end = text.indexOf(quote, 1);
		if (end < 0) throw new Error(`Unterminated quoted key in agent frontmatter: ${file}:${lineNumber}`);
		const key = unquote(text.slice(0, end + 1), file, lineNumber);
		const after = text.slice(end + 1);
		if (!after.startsWith(":")) {
			throw new Error(`Expected ":" after quoted key in agent frontmatter: ${file}:${lineNumber}`);
		}
		return { key, rest: after.slice(1).trim() };
	}
	const colon = findTopLevelColon(text);
	if (colon < 0) {
		throw new Error(`Expected "key: value" in agent frontmatter: ${file}:${lineNumber} ("${text}")`);
	}
	const key = text.slice(0, colon).trim();
	if (!key) {
		throw new Error(`Empty key in agent frontmatter: ${file}:${lineNumber}`);
	}
	return { key, rest: text.slice(colon + 1).trim() };
}

/** Find a mapping colon (": " or line-ending ":") outside quotes. */
function findTopLevelColon(text: string): number {
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ":" && (i === text.length - 1 || text[i + 1] === " ")) return i;
	}
	return -1;
}

/** Parse an inline value: scalar, quoted string, or inline array. */
function parseInlineValue(text: string, file: string, lineNumber: number): unknown {
	const stripped = stripTrailingComment(text);
	if (stripped === "") return undefined;
	if (stripped.startsWith("[")) return parseInlineArray(stripped, file, lineNumber);
	if (stripped.startsWith("{")) {
		throw new Error(`Flow maps "{...}" are not supported; use block (indented) form: ${file}:${lineNumber}`);
	}
	if (stripped.startsWith("|") || stripped.startsWith(">")) {
		throw new Error(`Block scalars ("|"/">") are not supported in frontmatter; put long text in the markdown body: ${file}:${lineNumber}`);
	}
	if (stripped.startsWith("&") || stripped.startsWith("*") || stripped.startsWith("!")) {
		throw new Error(`YAML anchors, aliases, and tags are not supported: ${file}:${lineNumber}`);
	}
	if (stripped.startsWith('"') || stripped.startsWith("'")) {
		return unquote(stripped, file, lineNumber);
	}
	return parseScalar(stripped);
}

function parseInlineArray(text: string, file: string, lineNumber: number): unknown[] {
	if (!text.endsWith("]")) {
		throw new Error(`Unterminated inline array in agent frontmatter: ${file}:${lineNumber}`);
	}
	const inner = text.slice(1, -1).trim();
	if (inner === "") return [];
	const items: string[] = [];
	let current = "";
	let quote = "";
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (quote) {
			current += ch;
			if (ch === quote && current[current.length - 2] !== "\\") quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ",") {
			items.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (quote) throw new Error(`Unterminated quoted string in inline array: ${file}:${lineNumber}`);
	if (current.trim() !== "" || items.length > 0) items.push(current.trim());
	return items.map((item) => {
		if (item.startsWith('"') || item.startsWith("'")) return unquote(item, file, lineNumber);
		return parseScalar(item);
	});
}

function unquote(text: string, file: string, lineNumber: number): string {
	const quote = text[0];
	if (!text.endsWith(quote) || text.length < 2) {
		throw new Error(`Unterminated quoted string in agent frontmatter: ${file}:${lineNumber}`);
	}
	const inner = text.slice(1, -1);
	if (quote === "'") return inner.replace(/''/g, "'");
	return inner
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

function parseScalar(text: string): unknown {
	const value = text.trim();
	if (value === "") return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null" || value === "~") return undefined;
	if (NUMERIC_PATTERN.test(value)) return Number(value);
	return value;
}

/** Strip a trailing `# comment` outside quotes. */
function stripTrailingComment(text: string): string {
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
			return text.slice(0, i).trimEnd();
		}
	}
	return text.trim();
}

/** Expand comma-separated strings for known array fields, at any depth. */
function expandCommaSeparatedArrays(value: Record<string, unknown>): void {
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && COMMA_SEPARATED_ARRAY_KEYS.has(key)) {
			value[key] = item.split(",").map((part) => part.trim()).filter((part) => part !== "");
		} else if (isPlainObject(item)) {
			expandCommaSeparatedArrays(item);
		}
	}
}
