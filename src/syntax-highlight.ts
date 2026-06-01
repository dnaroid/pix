import { basename, extname } from "node:path";
import type { Theme } from "./theme.js";

export type SyntaxHighlightLanguage =
	| "c"
	| "cpp"
	| "csharp"
	| "css"
	| "go"
	| "html"
	| "java"
	| "javascript"
	| "json"
	| "markdown"
	| "python"
	| "rust"
	| "shell"
	| "typescript"
	| "yaml";

export type SyntaxLineHighlight = {
	language: SyntaxHighlightLanguage;
	start: number;
};

export type ToolBodySyntaxHighlight = {
	language: SyntaxHighlightLanguage;
	startLine: number;
	endLine?: number;
	startColumn?: number;
};

export type ToolBodySyntaxHighlights = ToolBodySyntaxHighlight | readonly ToolBodySyntaxHighlight[];

export type SyntaxHighlightSegment = {
	start: number;
	end: number;
	foreground?: string;
	bold?: boolean;
};

type TokenStyle = "comment" | "constant" | "emphasis" | "keyword" | "number" | "property" | "string" | "tag" | "type";

type CodeLanguageSpec = {
	keywords: ReadonlySet<string>;
	types?: ReadonlySet<string>;
	constants?: ReadonlySet<string>;
	lineComment?: string;
	blockComment?: readonly [start: string, end: string];
};

const EXTENSION_LANGUAGES: Record<string, SyntaxHighlightLanguage> = {
	".c": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cs": "csharp",
	".css": "css",
	".cxx": "cpp",
	".go": "go",
	".h": "c",
	".hpp": "cpp",
	".html": "html",
	".java": "java",
	".js": "javascript",
	".jsx": "javascript",
	".json": "json",
	".jsonc": "json",
	".md": "markdown",
	".mjs": "javascript",
	".py": "python",
	".rs": "rust",
	".sh": "shell",
	".ts": "typescript",
	".tsx": "typescript",
	".yaml": "yaml",
	".yml": "yaml",
};

const BASENAME_LANGUAGES: Record<string, SyntaxHighlightLanguage> = {
	dockerfile: "shell",
	makefile: "shell",
};

const MARKDOWN_FENCE_LANGUAGES: Record<string, SyntaxHighlightLanguage> = {
	bash: "shell",
	c: "c",
	cc: "cpp",
	cpp: "cpp",
	cs: "csharp",
	csharp: "csharp",
	css: "css",
	cxx: "cpp",
	go: "go",
	html: "html",
	java: "java",
	javascript: "javascript",
	js: "javascript",
	json: "json",
	jsonc: "json",
	jsx: "javascript",
	python: "python",
	py: "python",
	rust: "rust",
	rs: "rust",
	sh: "shell",
	shell: "shell",
	ts: "typescript",
	tsx: "typescript",
	typescript: "typescript",
	yaml: "yaml",
	yml: "yaml",
	zsh: "shell",
};

const JS_KEYWORDS = words("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield");
const JS_TYPES = words("Array bigint boolean Map never number object Promise Record Set string symbol unknown any void");
const JS_CONSTANTS = words("false Infinity NaN null true undefined");
const PY_KEYWORDS = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield");
const PY_CONSTANTS = words("cls False None self True");
const GO_KEYWORDS = words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const GO_CONSTANTS = words("false iota nil true");
const RUST_KEYWORDS = words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while");
const RUST_TYPES = words("Box Option Result Self String Vec");
const RUST_CONSTANTS = words("Err false None Ok Some true");
const JAVA_KEYWORDS = words("abstract assert break case catch class const continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while");
const JAVA_TYPES = words("boolean byte char double float int long short String var void");
const JAVA_CONSTANTS = words("false null true");
const C_LIKE_KEYWORDS = words("break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while");
const C_LIKE_TYPES = words("bool char double float int int16_t int32_t int64_t int8_t long short size_t ssize_t uint16_t uint32_t uint64_t uint8_t unsigned void");
const CPP_KEYWORDS = words("alignas alignof and asm auto bitand bitor break case catch class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern for friend goto if import inline mutable namespace new noexcept not operator or private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while xor");
const CPP_TYPES = words("bool char char16_t char32_t double float int long short signed size_t std string unsigned void wchar_t");
const C_CONSTANTS = words("false NULL nullptr true");
const CSHARP_KEYWORDS = words("abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach get goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed set sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual void volatile while yield");
const CSHARP_TYPES = words("bool byte char decimal double dynamic float int long object sbyte short string uint ulong ushort var");
const CSHARP_CONSTANTS = words("false null true");
const SHELL_KEYWORDS = words("case do done elif else esac fi for function if in local readonly return select then until while");
const SHELL_CONSTANTS = words("false true");

const CODE_LANGUAGE_SPECS: Record<Exclude<SyntaxHighlightLanguage, "css" | "html" | "json" | "markdown" | "yaml">, CodeLanguageSpec> = {
	c: { keywords: C_LIKE_KEYWORDS, types: C_LIKE_TYPES, constants: C_CONSTANTS, lineComment: "//", blockComment: ["/*", "*/"] },
	cpp: { keywords: CPP_KEYWORDS, types: CPP_TYPES, constants: C_CONSTANTS, lineComment: "//", blockComment: ["/*", "*/"] },
	csharp: { keywords: CSHARP_KEYWORDS, types: CSHARP_TYPES, constants: CSHARP_CONSTANTS, lineComment: "//", blockComment: ["/*", "*/"] },
	go: { keywords: GO_KEYWORDS, constants: GO_CONSTANTS, lineComment: "//", blockComment: ["/*", "*/"] },
	java: { keywords: JAVA_KEYWORDS, types: JAVA_TYPES, constants: JAVA_CONSTANTS, lineComment: "//", blockComment: ["/*", "*/"] },
	javascript: { keywords: JS_KEYWORDS, types: JS_TYPES, constants: JS_CONSTANTS, lineComment: "//", blockComment: ["/*", "*/"] },
	python: { keywords: PY_KEYWORDS, constants: PY_CONSTANTS, lineComment: "#" },
	rust: { keywords: RUST_KEYWORDS, types: RUST_TYPES, constants: RUST_CONSTANTS, lineComment: "//", blockComment: ["/*", "*/"] },
	shell: { keywords: SHELL_KEYWORDS, constants: SHELL_CONSTANTS, lineComment: "#" },
	typescript: { keywords: JS_KEYWORDS, types: JS_TYPES, constants: JS_CONSTANTS, lineComment: "//", blockComment: ["/*", "*/"] },
};

export function syntaxHighlightLanguageForPath(filePath: string): SyntaxHighlightLanguage | undefined {
	const name = basename(filePath).toLowerCase();
	if (name.endsWith(".d.ts")) return "typescript";
	const byName = BASENAME_LANGUAGES[name];
	if (byName) return byName;
	return EXTENSION_LANGUAGES[extname(name)];
}

export function syntaxHighlightLanguageForMarkdownFence(info: string): SyntaxHighlightLanguage | undefined {
	const token = info.trim().split(/\s+/, 1)[0]?.toLowerCase().replace(/^[{.]+|[}.]+$/g, "") ?? "";
	if (!token) return undefined;
	return MARKDOWN_FENCE_LANGUAGES[token];
}

export function syntaxHighlightSegmentsForLine(
	text: string,
	highlight: SyntaxLineHighlight,
	colors: Theme["colors"],
): SyntaxHighlightSegment[] {
	const start = Math.max(0, Math.min(text.length, highlight.start));
	if (start >= text.length) return [];
	const segments = localSyntaxSegments(text.slice(start), highlight.language, colors);
	return segments.map((segment) => ({ ...segment, start: segment.start + start, end: segment.end + start }));
}

function localSyntaxSegments(code: string, language: SyntaxHighlightLanguage, colors: Theme["colors"]): SyntaxHighlightSegment[] {
	switch (language) {
		case "css":
			return cssSegments(code, colors);
		case "html":
			return htmlSegments(code, colors);
		case "json":
			return jsonSegments(code, colors);
		case "markdown":
			return markdownSegments(code, colors);
		case "yaml":
			return yamlSegments(code, colors);
		default:
			return codeSegments(code, CODE_LANGUAGE_SPECS[language], colors);
	}
}

function codeSegments(code: string, spec: CodeLanguageSpec, colors: Theme["colors"]): SyntaxHighlightSegment[] {
	const segments: SyntaxHighlightSegment[] = [];
	let index = 0;
	while (index < code.length) {
		const char = code[index] ?? "";

		if (spec.lineComment && code.startsWith(spec.lineComment, index) && isLineCommentStart(code, index, spec.lineComment)) {
			addSegment(segments, index, code.length, "comment", colors);
			break;
		}

		if (spec.blockComment && code.startsWith(spec.blockComment[0], index)) {
			const end = code.indexOf(spec.blockComment[1], index + spec.blockComment[0].length);
			const commentEnd = end === -1 ? code.length : end + spec.blockComment[1].length;
			addSegment(segments, index, commentEnd, "comment", colors);
			index = commentEnd;
			continue;
		}

		if (isQuote(char)) {
			const end = consumeQuoted(code, index, char);
			addSegment(segments, index, end, "string", colors);
			index = end;
			continue;
		}

		if (isNumberStart(code, index)) {
			const end = consumeNumber(code, index);
			addSegment(segments, index, end, "number", colors);
			index = end;
			continue;
		}

		if (isIdentifierStart(char)) {
			const end = consumeIdentifier(code, index);
			const word = code.slice(index, end);
			if (spec.keywords.has(word)) addSegment(segments, index, end, "keyword", colors);
			else if (spec.types?.has(word)) addSegment(segments, index, end, "type", colors);
			else if (spec.constants?.has(word)) addSegment(segments, index, end, "constant", colors);
			index = end;
			continue;
		}

		index += 1;
	}
	return segments;
}

function jsonSegments(code: string, colors: Theme["colors"]): SyntaxHighlightSegment[] {
	const segments: SyntaxHighlightSegment[] = [];
	let index = 0;
	while (index < code.length) {
		if (code.startsWith("//", index)) {
			addSegment(segments, index, code.length, "comment", colors);
			break;
		}

		const char = code[index] ?? "";
		if (char === '"') {
			const end = consumeQuoted(code, index, char);
			addSegment(segments, index, end, isJsonProperty(code, end) ? "property" : "string", colors);
			index = end;
			continue;
		}
		if (isNumberStart(code, index)) {
			const end = consumeNumber(code, index);
			addSegment(segments, index, end, "number", colors);
			index = end;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = consumeIdentifier(code, index);
			const word = code.slice(index, end);
			if (word === "true" || word === "false" || word === "null") addSegment(segments, index, end, "constant", colors);
			index = end;
			continue;
		}
		index += 1;
	}
	return segments;
}

function yamlSegments(code: string, colors: Theme["colors"]): SyntaxHighlightSegment[] {
	const commentStart = unquotedIndexOf(code, "#");
	const body = commentStart === -1 ? code : code.slice(0, commentStart);
	const segments = jsonLikeValueSegments(body, colors);
	const keyMatch = /^(\s*-?\s*)([A-Za-z0-9_.-]+)(\s*:)/.exec(body);
	const yamlKey = keyMatch?.[2];
	if (yamlKey) {
		const start = (keyMatch[1] ?? "").length;
		addSegment(segments, start, start + yamlKey.length, "property", colors);
	}
	if (commentStart !== -1) addSegment(segments, commentStart, code.length, "comment", colors);
	return sortedSegments(segments);
}

function markdownSegments(code: string, colors: Theme["colors"]): SyntaxHighlightSegment[] {
	const segments: SyntaxHighlightSegment[] = [];
	const heading = /^(\s{0,3}#{1,6}\s+)(.*)$/.exec(code);
	if (heading) {
		addSegment(segments, 0, code.length, "tag", colors, true);
		return segments;
	}
	const fence = /^\s*`{3,}/.exec(code);
	if (fence) {
		addSegment(segments, fence.index, code.length, "keyword", colors);
		return segments;
	}
	const list = /^(\s*)(?:[-*+] |\d+\. )/.exec(code);
	if (list) addSegment(segments, (list[1] ?? "").length, list[0].length, "keyword", colors);
	for (const match of code.matchAll(/`[^`]+`/g)) addSegment(segments, match.index, match.index + match[0].length, "string", colors);
	for (const match of code.matchAll(/\[[^\]]+\]\([^)]+\)/g)) addSegment(segments, match.index, match.index + match[0].length, "tag", colors);
	for (const match of code.matchAll(/\*\*[^*\n]+?\*\*|__[^_\n]+?__/g)) addMarkdownSegment(segments, match.index, match.index + match[0].length, "emphasis", colors, true);
	for (const range of singleAsteriskEmphasisRanges(code)) addMarkdownSegment(segments, range.start, range.end, "emphasis", colors);
	return sortedSegments(segments);
}

function singleAsteriskEmphasisRanges(code: string): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	let index = 0;
	while (index < code.length) {
		if (code[index] !== "*" || !isSingleAsteriskEmphasisOpen(code, index)) {
			index += 1;
			continue;
		}

		const end = findSingleAsteriskEmphasisEnd(code, index + 1);
		if (end === -1) {
			index += 1;
			continue;
		}

		ranges.push({ start: index, end: end + 1 });
		index = end + 1;
	}
	return ranges;
}

function findSingleAsteriskEmphasisEnd(code: string, start: number): number {
	for (let index = start; index < code.length; index += 1) {
		if (code[index] === "*" && isSingleAsteriskEmphasisClose(code, index)) return index;
	}
	return -1;
}

function isSingleAsteriskEmphasisOpen(code: string, index: number): boolean {
	if (code[index - 1] === "*" || code[index + 1] === "*" || isEscapedMarkdownMarker(code, index)) return false;
	const previous = code[index - 1] ?? "";
	const next = code[index + 1] ?? "";
	return next !== "" && !/\s/.test(next) && !isMarkdownClosingPunctuation(next) && (previous === "" || /\s/.test(previous) || isMarkdownOpeningPunctuation(previous));
}

function isSingleAsteriskEmphasisClose(code: string, index: number): boolean {
	if (code[index - 1] === "*" || code[index + 1] === "*" || isEscapedMarkdownMarker(code, index)) return false;
	const previous = code[index - 1] ?? "";
	const next = code[index + 1] ?? "";
	return previous !== "" && !/\s/.test(previous) && !isMarkdownOpeningPunctuation(previous) && (next === "" || /\s/.test(next) || isMarkdownClosingPunctuation(next));
}

function isEscapedMarkdownMarker(code: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && code[cursor] === "\\"; cursor -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

function isMarkdownOpeningPunctuation(char: string): boolean {
	return "([{<\"'“‘".includes(char);
}

function isMarkdownClosingPunctuation(char: string): boolean {
	return ")]}>,.!?;:\"'”’".includes(char);
}

function htmlSegments(code: string, colors: Theme["colors"]): SyntaxHighlightSegment[] {
	const segments: SyntaxHighlightSegment[] = [];
	let index = 0;
	while (index < code.length) {
		if (code.startsWith("<!--", index)) {
			const end = code.indexOf("-->", index + 4);
			const commentEnd = end === -1 ? code.length : end + 3;
			addSegment(segments, index, commentEnd, "comment", colors);
			index = commentEnd;
			continue;
		}
		if (code[index] === "<") {
			const end = code.indexOf(">", index + 1);
			const tagEnd = end === -1 ? code.length : end + 1;
			htmlTagSegments(code.slice(index, tagEnd), index, segments, colors);
			index = tagEnd;
			continue;
		}
		index += 1;
	}
	return sortedSegments(segments);
}

function cssSegments(code: string, colors: Theme["colors"]): SyntaxHighlightSegment[] {
	const segments: SyntaxHighlightSegment[] = [];
	let index = 0;
	while (index < code.length) {
		if (code.startsWith("/*", index)) {
			const end = code.indexOf("*/", index + 2);
			const commentEnd = end === -1 ? code.length : end + 2;
			addSegment(segments, index, commentEnd, "comment", colors);
			index = commentEnd;
			continue;
		}
		const char = code[index] ?? "";
		if (isQuote(char)) {
			const end = consumeQuoted(code, index, char);
			addSegment(segments, index, end, "string", colors);
			index = end;
			continue;
		}
		if (char === "@") {
			const end = consumeIdentifier(code, index + 1);
			addSegment(segments, index, end, "keyword", colors);
			index = end;
			continue;
		}
		if (isNumberStart(code, index)) {
			const end = consumeCssNumber(code, index);
			addSegment(segments, index, end, "number", colors);
			index = end;
			continue;
		}
		if (isCssPropertyStart(code, index)) {
			const end = consumeCssProperty(code, index);
			addSegment(segments, index, end, "property", colors);
			index = end;
			continue;
		}
		index += 1;
	}
	return sortedSegments(segments);
}

function jsonLikeValueSegments(code: string, colors: Theme["colors"]): SyntaxHighlightSegment[] {
	const segments: SyntaxHighlightSegment[] = [];
	let index = 0;
	while (index < code.length) {
		const char = code[index] ?? "";
		if (isQuote(char)) {
			const end = consumeQuoted(code, index, char);
			addSegment(segments, index, end, "string", colors);
			index = end;
			continue;
		}
		if (isNumberStart(code, index)) {
			const end = consumeNumber(code, index);
			addSegment(segments, index, end, "number", colors);
			index = end;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = consumeIdentifier(code, index);
			const word = code.slice(index, end);
			if (word === "true" || word === "false" || word === "null") addSegment(segments, index, end, "constant", colors);
			index = end;
			continue;
		}
		index += 1;
	}
	return segments;
}

function htmlTagSegments(tagText: string, offset: number, segments: SyntaxHighlightSegment[], colors: Theme["colors"]): void {
	const tagName = /^<\/?\s*([A-Za-z][\w:-]*)/.exec(tagText);
	if (tagName?.[1]) {
		const start = tagText.indexOf(tagName[1]);
		addSegment(segments, offset + start, offset + start + tagName[1].length, "tag", colors, true);
	}
	for (const match of tagText.matchAll(/\s([A-Za-z_:][\w:.-]*)(?=\s*=)/g)) {
		const attribute = match[1];
		if (attribute) addSegment(segments, offset + match.index + 1, offset + match.index + 1 + attribute.length, "property", colors);
	}
	for (const match of tagText.matchAll(/(["'])[^"']*\1/g)) {
		addSegment(segments, offset + match.index, offset + match.index + match[0].length, "string", colors);
	}
}

function isJsonProperty(code: string, end: number): boolean {
	let index = end;
	while (index < code.length && /\s/.test(code[index] ?? "")) index += 1;
	return code[index] === ":";
}

function isLineCommentStart(code: string, index: number, marker: string): boolean {
	if (marker !== "#") return true;
	return index === 0 || /\s/.test(code[index - 1] ?? "");
}

function unquotedIndexOf(code: string, needle: string): number {
	let index = 0;
	while (index < code.length) {
		const char = code[index] ?? "";
		if (isQuote(char)) {
			index = consumeQuoted(code, index, char);
			continue;
		}
		if (code.startsWith(needle, index)) return index;
		index += 1;
	}
	return -1;
}

function addSegment(
	segments: SyntaxHighlightSegment[],
	start: number | undefined,
	end: number,
	style: TokenStyle,
	colors: Theme["colors"],
	bold = false,
): void {
	if (start === undefined || end <= start) return;
	const segment: SyntaxHighlightSegment = { start, end, foreground: tokenColor(style, colors) };
	if (bold || style === "keyword" || style === "tag") segment.bold = true;
	segments.push(segment);
}

function addMarkdownSegment(
	segments: SyntaxHighlightSegment[],
	start: number | undefined,
	end: number,
	style: TokenStyle,
	colors: Theme["colors"],
	bold = false,
): void {
	if (start === undefined || segments.some((segment) => start < segment.end && end > segment.start)) return;
	addSegment(segments, start, end, style, colors, bold);
}

function tokenColor(style: TokenStyle, colors: Theme["colors"]): string {
	switch (style) {
		case "comment":
			return colors.muted;
		case "emphasis":
			return colors.accent;
		case "constant":
		case "number":
			return colors.warning;
		case "keyword":
		case "tag":
			return colors.accent;
		case "property":
		case "type":
			return colors.info;
		case "string":
			return colors.success;
	}
}

function sortedSegments(segments: SyntaxHighlightSegment[]): SyntaxHighlightSegment[] {
	return segments.sort((left, right) => left.start - right.start || left.end - right.end);
}

function consumeQuoted(text: string, start: number, quote: string): number {
	let index = start + 1;
	while (index < text.length) {
		const char = text[index] ?? "";
		if (char === "\\") {
			index += 2;
			continue;
		}
		index += 1;
		if (char === quote) break;
	}
	return Math.min(index, text.length);
}

function consumeNumber(text: string, start: number): number {
	let index = start;
	while (index < text.length && /[\w.+-]/.test(text[index] ?? "")) index += 1;
	return index;
}

function consumeCssNumber(text: string, start: number): number {
	let index = start;
	while (index < text.length && /[\w.%-]/.test(text[index] ?? "")) index += 1;
	return index;
}

function consumeIdentifier(text: string, start: number): number {
	let index = start;
	while (index < text.length && /[A-Za-z0-9_$-]/.test(text[index] ?? "")) index += 1;
	return index;
}

function consumeCssProperty(text: string, start: number): number {
	let index = start;
	while (index < text.length && /[A-Za-z-]/.test(text[index] ?? "")) index += 1;
	return index;
}

function isCssPropertyStart(text: string, index: number): boolean {
	if (!/[A-Za-z-]/.test(text[index] ?? "")) return false;
	const end = consumeCssProperty(text, index);
	let cursor = end;
	while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
	return text[cursor] === ":";
}

function isNumberStart(text: string, index: number): boolean {
	const char = text[index] ?? "";
	const prev = text[index - 1] ?? "";
	return /\d/.test(char) && !/[A-Za-z_$]/.test(prev);
}

function isIdentifierStart(char: string): boolean {
	return /[A-Za-z_$]/.test(char);
}

function isQuote(char: string): boolean {
	return char === '"' || char === "'" || char === "`";
}

function words(value: string): ReadonlySet<string> {
	return new Set(value.split(/\s+/).filter(Boolean));
}
