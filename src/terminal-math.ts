import katex from "katex";
import { stringDisplayWidth } from "./terminal-width.js";

const MAX_MATH_LENGTH = 8_192;
const MAX_MATHML_LENGTH = 120_000;
const MATH_CACHE_LIMIT = 128;

type MathNode = { tag: string; children: MathNode[]; text?: string };
type MathGrid = { lines: string[]; width: number; baseline: number };
type MathRender = { grid: MathGrid; linear: string };

const mathCache = new Map<string, MathRender | null>();

export type TerminalMathBlock = {
	source: string;
	raw: string;
	lineCount: number;
	complete: boolean;
};

export function terminalMathBlockAt(lines: readonly string[], start: number): TerminalMathBlock | undefined {
	const opening = /^ {0,3}(\\\[|\$\$)(.*)$/u.exec(lines[start] ?? "");
	if (!opening) return undefined;
	const closer = opening[1] === "\\[" ? "\\]" : "$$";
	const firstLine = opening[2] ?? "";
	if (firstLine.includes(closer) && firstLine.slice(firstLine.lastIndexOf(closer) + closer.length).trim()) {
		return undefined;
	}
	const body: string[] = [];
	for (let index = start; index < lines.length; index += 1) {
		const line = index === start ? opening[2] ?? "" : lines[index] ?? "";
		const closeIndex = line.lastIndexOf(closer);
		if (closeIndex >= 0 && !line.slice(closeIndex + closer.length).trim()
			&& (closeIndex === 0 || line[closeIndex - 1] !== "\\")) {
			body.push(line.slice(0, closeIndex));
			return {
				source: body.join("\n").trim(),
				raw: lines.slice(start, index + 1).join("\n"),
				lineCount: index - start + 1,
				complete: true,
			};
		}
		body.push(line);
	}
	return {
		source: body.join("\n").trim(),
		raw: lines.slice(start).join("\n"),
		lineCount: lines.length - start,
		complete: false,
	};
}

export function terminalInlineMathAt(text: string, start: number): { source: string; end: number } | undefined {
	const opener = text.startsWith("\\(", start) ? "\\("
		: text.startsWith("\\[", start) ? "\\["
			: text[start] === "$" && text[start + 1] !== "$" ? "$" : undefined;
	if (!opener) return undefined;
	const closer = opener === "\\(" ? "\\)" : opener === "\\[" ? "\\]" : "$";
	const from = start + opener.length;
	if (opener === "$" && (!text[from] || /\s/u.test(text[from] ?? ""))) return undefined;
	for (let index = from; index < text.length; index += 1) {
		if (text[index] === "\n") break;
		if (text[index] === "\\" && text[index + 1] && !text.startsWith(closer, index)) {
			index += 1;
			continue;
		}
		if (!text.startsWith(closer, index)) continue;
		if (opener === "$" && /\s/u.test(text[index - 1] ?? "")) continue;
		const source = text.slice(from, index);
		if (!source.trim() || source.length > MAX_MATH_LENGTH) return undefined;
		return { source, end: index + closer.length };
	}
	return undefined;
}

/** LaTeX is parsed by KaTeX, then its MathML is laid out with terminal Unicode. */
export function renderTerminalMath(source: string, displayMode: boolean, maxWidth = 80): string[] | undefined {
	if (!source.trim() || source.length > MAX_MATH_LENGTH) return undefined;
	let result: MathRender | null;
	if (mathCache.has(source)) {
		result = mathCache.get(source) ?? null;
	} else {
		result = parseTerminalMath(source);
		if (mathCache.size >= MATH_CACHE_LIMIT) mathCache.delete(mathCache.keys().next().value ?? "");
		mathCache.set(source, result);
	}
	if (!result) return undefined;
	if (!displayMode || result.grid.width > Math.max(1, maxWidth)) return [result.linear];
	return result.grid.lines;
}

function parseTerminalMath(source: string): MathRender | null {
	try {
		const mathml = katex.renderToString(source, {
			output: "mathml",
			throwOnError: true,
			trust: false,
			strict: "ignore",
			maxExpand: 1_000,
			maxSize: 10,
		});
		if (mathml.length > MAX_MATHML_LENGTH) return null;
		const node = parseMathml(mathml);
		if (!node) return null;
		return { grid: layoutNode(node), linear: linearNode(node).trim() };
	} catch {
		return null;
	}
}

/** Parses only the trusted, locally generated MathML subset, not user HTML. */
function parseMathml(xml: string): MathNode | undefined {
	const root: MathNode = { tag: "root", children: [] };
	const stack: MathNode[] = [root];
	for (const token of xml.match(/<[^>]*>|[^<]+/gu) ?? []) {
		if (token.startsWith("</")) {
			const tag = /^<\/([\w:-]+)\s*>$/u.exec(token)?.[1];
			if (stack.length <= 1 || stack.at(-1)?.tag !== tag) return undefined;
			stack.pop();
		} else if (token.startsWith("<")) {
			const tag = /^<([\w:-]+)(?:\s|\/?>)/u.exec(token)?.[1];
			if (!tag) return undefined;
			const node: MathNode = { tag, children: [] };
			stack.at(-1)?.children.push(node);
			if (!token.endsWith("/>")) stack.push(node);
		} else {
			stack.at(-1)?.children.push({ tag: "#text", text: decodeMathText(token), children: [] });
		}
	}
	return stack.length === 1 ? root : undefined;
}

function decodeMathText(value: string): string {
	return value.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/giu, (entity, numeric: string | undefined, named: string | undefined) => {
		if (numeric) {
			const codePoint = numeric.startsWith("x") ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
			return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}
		return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[named?.toLowerCase() ?? ""] ?? entity;
	}).replace(/[\u00a0\u2061\u2062\u2063\u2064\u200b]/gu, (character) => character === "\u00a0" ? " " : "")
		.replace(/[\u0000-\u001f\u007f]/gu, " ");
}

function contentChildren(node: MathNode): MathNode[] {
	return node.children.filter((child) => child.tag !== "annotation" && child.tag !== "annotation-xml");
}

function linearNode(node: MathNode): string {
	const children = contentChildren(node);
	const get = (index: number) => children[index] ? linearNode(children[index]!) : "";
	switch (node.tag) {
		case "#text": return node.text ?? "";
		case "annotation":
		case "annotation-xml": return "";
		case "mo": return operatorText(children.map(linearNode).join(""));
		case "mfrac": return `(${get(0)})/(${get(1)})`;
		case "msup": return get(0) + scriptText(get(1), true);
		case "msub": return get(0) + scriptText(get(1), false);
		case "msubsup": return get(0) + scriptText(get(1), false) + scriptText(get(2), true);
		case "msqrt": return `√(${children.map(linearNode).join("")})`;
		case "mroot": return `${scriptText(get(1), true)}√(${get(0)})`;
		case "mspace": return " ";
		case "munder": return get(0) + scriptText(get(1), false);
		case "mover": return get(0) + scriptText(get(1), true);
		case "munderover": return get(0) + scriptText(get(1), false) + scriptText(get(2), true);
		case "mphantom": return "";
		default: return children.map(linearNode).join("");
	}
}

function operatorText(value: string): string {
	return /^[+=−×÷∩∪]$/u.test(value) ? ` ${value} ` : value;
}

const SUPERSCRIPT: Record<string, string> = {
	"0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
	"+": "⁺", "−": "⁻", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ",
};
const SUBSCRIPT: Record<string, string> = {
	"0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
	"+": "₊", "−": "₋", "-": "₋", "=": "₌", "(": "₍", ")": "₎", "a": "ₐ", "e": "ₑ", "i": "ᵢ", "n": "ₙ", "o": "ₒ", "r": "ᵣ", "x": "ₓ",
};

function scriptText(text: string, superscript: boolean): string {
	const map = superscript ? SUPERSCRIPT : SUBSCRIPT;
	const converted = [...text].map((character) => map[character]);
	return converted.every(Boolean) ? converted.join("") : `${superscript ? "^" : "_"}(${text})`;
}

function simpleGrid(text: string): MathGrid {
	return { lines: [text], width: stringDisplayWidth(text), baseline: 0 };
}

function layoutNode(node: MathNode): MathGrid {
	const children = contentChildren(node);
	const get = (index: number) => children[index] ? layoutNode(children[index]!) : simpleGrid("");
	switch (node.tag) {
		case "#text": return simpleGrid(node.text ?? "");
		case "annotation":
		case "annotation-xml":
		case "mphantom": return simpleGrid("");
		case "mo": return simpleGrid(operatorText(children.map(linearNode).join("")));
		case "mfrac": {
			const numerator = get(0);
			const denominator = get(1);
			const width = Math.max(numerator.width, denominator.width, 1) + 2;
			return {
				lines: [
					...numerator.lines.map((line) => center(line, width)),
					"─".repeat(width),
					...denominator.lines.map((line) => center(line, width)),
				],
				width,
				baseline: numerator.lines.length,
			};
		}
		case "msup":
		case "msub":
		case "msubsup":
		case "msqrt":
		case "mroot":
		case "munder":
		case "mover":
		case "munderover": return simpleGrid(linearNode(node));
		case "mspace": return simpleGrid(" ");
		default: return joinGrids(children.map(layoutNode));
	}
}

function center(text: string, width: number): string {
	const padding = Math.max(0, width - stringDisplayWidth(text));
	return " ".repeat(Math.floor(padding / 2)) + text + " ".repeat(Math.ceil(padding / 2));
}

function joinGrids(grids: readonly MathGrid[]): MathGrid {
	if (grids.length === 0) return simpleGrid("");
	const baseline = Math.max(...grids.map((grid) => grid.baseline));
	const below = Math.max(...grids.map((grid) => grid.lines.length - grid.baseline - 1));
	const lines: string[] = [];
	for (let row = 0; row <= baseline + below; row += 1) {
		let combined = "";
		for (const grid of grids) {
			const index = row - baseline + grid.baseline;
			const line = grid.lines[index] ?? "";
			combined += line + " ".repeat(Math.max(0, grid.width - stringDisplayWidth(line)));
		}
		lines.push(combined.trimEnd());
	}
	return { lines, width: grids.reduce((sum, grid) => sum + grid.width, 0), baseline };
}
