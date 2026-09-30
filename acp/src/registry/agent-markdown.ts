// Registry-only strict frontmatter parser. Kept in parity with tools-suite agents-dir.ts.
const KNOWN_FRONTMATTER_KEYS = new Set([
	"name",
	"description",
	"tags",
	"icon",
	"models",
	"modelSelection",
	"model",
	"fallbackModels",
	"modelByParent",
	"forParentModels",
	"notForParentModels",
	"forParentTier",
	"requiresIndexedProject",
	"parentProviderPolicy",
	"requireDifferentProvider",
	"thinking",
	"tools",
	"extraArgs",
	"promptAppend",
	"promptOverride",
	"retry",
	"maxResultBytes",
	"timeoutMs",
]);

const NUMERIC_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseAgentMarkdown(
	source: string,
	file: string,
): { frontmatter: Record<string, unknown>; body: string } | undefined {
	const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	if (lines[0]!?.trim() !== "---") return undefined;

	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!.trim();
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
		const rawLine = lines[i]!;
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
		const line = sourceLines[next]!;
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
	if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))) {
		throw new Error(`Agent tags must be an array of strings: ${file}`);
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipIgnorable(lines: SourceLine[], start: number): number {
	let i = start;
	while (i < lines.length && (lines[i]!.text === "" || lines[i]!.text.startsWith("#"))) i++;
	return i;
}

function isListItem(text: string): boolean {
	return text === "-" || text.startsWith("- ");
}

function parseBlock(
	lines: SourceLine[],
	start: number,
	indent: number,
	file: string,
): [unknown, number] {
	const first = skipIgnorable(lines, start);
	if (first >= lines.length || lines[first]!.indent < indent) return [undefined, first];
	if (isListItem(lines[first]!.text)) return parseList(lines, first, indent, file);
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
		const line = lines[i]!;
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
			if (peek < lines.length && (lines[peek]!.indent > indent || (lines[peek]!.indent === indent && isListItem(lines[peek]!.text)))) {
				const [child, next] = parseBlock(lines, peek, lines[peek]!.indent, file);
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
		const line = lines[i]!;
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

function splitKey(text: string, file: string, lineNumber: number): { key: string; rest: string } {
	if (text.startsWith('"') || text.startsWith("'")) {
		const quote = text[0]!;
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

function findTopLevelColon(text: string): number {
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ":" && (i === text.length - 1 || text[i + 1]! === " ")) return i;
	}
	return -1;
}

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
		const ch = inner[i]!;
		if (quote) {
			current += ch;
			if (ch === quote && current[current.length - 2]! !== "\\") quote = "";
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
	const quote = text[0]!;
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

function stripTrailingComment(text: string): string {
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === 0 || text[i - 1]! === " " || text[i - 1]! === "\t")) {
			return text.slice(0, i).trimEnd();
		}
	}
	return text.trim();
}
