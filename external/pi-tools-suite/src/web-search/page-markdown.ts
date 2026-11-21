import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5";

type Node = Tree.Node;
type Element = Tree.Element;
type Context = { url: URL; page: string; images: Set<string>; plainLinks?: boolean };

const omittedTags = new Set([
	"aside", "button", "dialog", "footer", "form", "head", "iframe", "input", "nav", "noscript",
	"script", "select", "style", "svg", "template", "textarea",
]);
const omittedRoles = new Set([
	"banner", "complementary", "contentinfo", "dialog", "menu", "menubar", "navigation", "search", "toolbar",
]);
// Class/id words that mark page chrome rather than content (Readability-style "unlikely candidates").
const noiseWords = new Set([
	"ad", "ads", "advert", "advertisement", "ambox", "breadcrumb", "breadcrumbs", "catlinks", "cookie", "cookies",
	"dropdown", "editsection", "feedback", "footer", "hatnote", "infobox", "menu", "metadata", "navbar", "navbox",
	"newsletter", "noprint", "popup", "portlet", "promo", "related", "share", "sharing", "sidebar", "social",
	"sponsored", "toc", "toolbar", "tooltip",
]);
// "body"/"text" are omitted: utility classes such as `text-sm` or `bg-body` would otherwise veto real noise markers.
const contentWords = new Set(["article", "content", "entry", "main", "post", "story"]);
const screenReaderTokens = new Set(["sr-only", "visually-hidden", "screen-reader-text"]);
const containers = new Set(["html", "body", "main", "article"]);
const blockTags = /^(?:address|article|div|figcaption|figure|header|li|main|p|section|tbody|td|tfoot|th|thead|tr)$/;
const MAX_DEPTH = 80;
const LINK_LIST_DENSITY = 0.8;

function isElement(node: Node): node is Element {
	return "tagName" in node;
}

function children(node: Node): Node[] {
	return "childNodes" in node ? node.childNodes : [];
}

function attr(node: Element, name: string): string | undefined {
	return node.attrs.find((item) => item.name === name)?.value;
}

function isChrome(node: Element): boolean {
	if (containers.has(node.tagName)) return false;
	const tokens = `${attr(node, "class") ?? ""} ${attr(node, "id") ?? ""}`.toLowerCase().split(/\s+/);
	let noise = false;
	for (const token of tokens) {
		if (!token) continue;
		if (screenReaderTokens.has(token)) return true;
		const words = token.split(/[-_]+/);
		if (words.some((word) => noiseWords.has(word))) noise = true;
		else if (words.some((word) => contentWords.has(word))) return false;
	}
	return noise;
}

function omitted(node: Element): boolean {
	return omittedTags.has(node.tagName) || omittedRoles.has(attr(node, "role") ?? "") ||
		attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true" || isChrome(node);
}

function* elements(root: Node, include: (element: Element) => boolean = () => true): Generator<Element> {
	const pending = [root];
	while (pending.length) {
		const node = pending.pop()!;
		if (isElement(node)) {
			if (!include(node)) continue;
			yield node;
		}
		const nested = children(node);
		for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]);
	}
}

function rawText(node: Node, depth = 0): string {
	if (depth > MAX_DEPTH) return "";
	if ("value" in node) return node.value;
	if (isElement(node) && node.tagName === "br") return "\n";
	return children(node).map((child) => rawText(child, depth + 1)).join("");
}

function visibleTextLength(node: Node): number {
	return rawText(node).replace(/\s+/g, "").length;
}

function isLinkList(items: Element[]): boolean {
	if (items.length < 2) return false;
	let text = 0;
	let linked = 0;
	for (const item of items) {
		text += visibleTextLength(item);
		for (const link of elements(item)) if (link.tagName === "a" && attr(link, "href")) linked += visibleTextLength(link);
	}
	return text > 0 && linked / text >= LINK_LIST_DENSITY;
}

// Readability-style data-table detection: tables used only for page layout are flattened into blocks.
// A block of three or more links joined only by separators is a navigation bar, not content.
function isLinkBar(node: Element): boolean {
	let links = 0;
	let linkText = 0;
	let outside = "";
	let prose = false;
	const walk = (current: Node, depth: number): void => {
		if (prose || depth > MAX_DEPTH) return;
		if ("value" in current) {
			outside += current.value;
			prose = /[\p{L}\p{N}]/u.test(current.value);
		} else if (!isElement(current) || omitted(current)) return;
		else if (current.tagName === "a" && attr(current, "href")) {
			const text = rawText(current).replace(/\s+/g, " ").trim();
			if (/[\p{L}\p{N}]/u.test(text)) {
				links++;
				linkText += text.length;
			}
		} else for (const child of children(current)) walk(child, depth + 1);
	};
	walk(node, 0);
	// Navigation labels are short; long link texts (headlines, article titles) are content.
	return links >= 3 && linkText / links <= 24 && !/[\p{L}\p{N}]/u.test(outside);
}

function isLayoutTable(node: Element): boolean {
	const role = attr(node, "role");
	if (role === "presentation" || role === "none") return true;
	if (attr(node, "summary")) return false;
	let rows = 0;
	let columns = 0;
	for (const nested of elements(node)) {
		if (nested === node) continue;
		if (nested.tagName === "table") return true;
		if (/^(?:caption|col|colgroup|tfoot|th|thead)$/.test(nested.tagName)) return false;
		if (nested.tagName === "tr") {
			rows++;
			columns = Math.max(columns, children(nested).filter((cell) => isElement(cell) && cell.tagName === "td").length);
		}
	}
	if (rows <= 1 || columns <= 1) return true;
	return rows < 10 && columns <= 4 && rows * columns <= 10;
}

function escapeText(value: string): string {
	return value.replace(/[\t\n\r\f ]+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
}

function block(value: string): string {
	return value.trim() ? `\n\n${value.trim()}\n\n` : "";
}

function fenceFor(value: string, minLength: number): string {
	let length = minLength;
	for (const run of value.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
	return "`".repeat(length);
}

function wrapInline(value: string, prefix: string, suffix = prefix): string {
	return value.replace(/^(\s*)(\S[\s\S]*?)(\s*)$/, (_match, before, inner, after) => `${before}${prefix}${inner}${suffix}${after}`);
}

function renderChildren(node: Element, ctx: Context, depth: number): string {
	const parts: string[] = [];
	for (const child of children(node)) {
		const part = render(child, ctx, depth + 1);
		if (!part) continue;
		if (part.startsWith("\n\n")) {
			while (parts[parts.length - 1] === " ") parts.pop();
			if (parts[parts.length - 1]?.endsWith("\n\n")) {
				parts.push(part.slice(2));
				continue;
			}
		}
		if (part !== " " || !parts[parts.length - 1]?.endsWith("\n\n")) parts.push(part);
	}
	return parts.join("");
}

function renderTable(node: Element, ctx: Context, depth: number): string {
	const rows: string[][] = [];
	let firstRowIsHeader = false;
	for (const group of children(node).filter(isElement)) {
		const rowElements = group.tagName === "tr" ? [group] :
			/^(?:thead|tbody|tfoot)$/.test(group.tagName) ? children(group).filter(isElement) : [];
		for (const row of rowElements) {
			if (row.tagName !== "tr" || omitted(row)) continue;
			const cells = children(row).filter(isElement).filter((cell) => /^(?:th|td)$/.test(cell.tagName));
			if (!cells.length) continue;
			if (!rows.length) firstRowIsHeader = cells.some((cell) => cell.tagName === "th");
			rows.push(cells.map((cell) => render(cell, ctx, depth + 1).trim().replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|")));
		}
	}
	if (!rows.length) return "";
	// Avoid padding every row to the widest pathological row.
	const width = rows[0].length;
	const line = (row: string[]) => `| ${row.join(" | ")} |`;
	const header = firstRowIsHeader ? rows.shift()! : new Array<string>(width).fill(" ");
	return block([line(header), line(new Array<string>(width).fill("---")), ...rows.map(line)].join("\n"));
}

function renderLink(node: Element, value: string, ctx: Context): string {
	const href = attr(node, "href");
	const target = href && URL.parse(href, ctx.url);
	// Script-only controls such as collapse toggles ("[–]") have no readable text.
	if (target && target.protocol === "javascript:" && !/[\p{L}\p{N}]/u.test(value)) return "";
	if (ctx.plainLinks || !value.trim() || !target || !["http:", "https:"].includes(target.protocol) ||
		target.username || target.password) return value;
	// Same-document anchors (heading permalinks, footnote markers, tables of contents) carry no new information.
	if (target.hash && target.href.slice(0, -target.hash.length) === ctx.page) return value;
	// Same-site links are root-relative to the page URL reported with the result, which saves the repeated origin.
	const link = target.origin === ctx.url.origin ? target.href.slice(target.origin.length) : target.href;
	const destination = link.replace(/[()]/g, (char) => char === "(" ? "%28" : "%29");
	return wrapInline(value, "[", `](${destination})`);
}

function render(node: Node, ctx: Context, depth = 0): string {
	if (depth > MAX_DEPTH) return "";
	if (!isElement(node)) return "value" in node ? escapeText(node.value) : "";
	if (omitted(node)) return "";
	const tag = node.tagName;
	if (tag === "pre") {
		const value = rawText(node).trimEnd();
		const fence = fenceFor(value, 3);
		const code = children(node).find((child): child is Element => isElement(child) && child.tagName === "code");
		const language = code && attr(code, "class")?.match(/(?:^|\s)language-([\w+.-]+)/)?.[1];
		return block(`${fence}${language ?? ""}\n${value}\n${fence}`);
	}
	if (tag === "code") {
		const value = rawText(node).replace(/\s+/g, " ").trim();
		if (!value) return "";
		const fence = fenceFor(value, 1);
		const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
		return `${fence}${pad}${value}${pad}${fence}`;
	}
	if (tag === "table") return isLayoutTable(node) ? block(renderChildren(node, ctx, depth)) : renderTable(node, ctx, depth);
	if (tag === "img") {
		// Responsive/theme variants repeat the same image; keep each description once.
		const alt = (attr(node, "alt") ?? "").replace(/\s+/g, " ").trim();
		if (!alt || ctx.images.has(alt)) return "";
		ctx.images.add(alt);
		return escapeText(alt);
	}
	if (tag === "br") return "  \n";
	if (tag === "hr") return block("---");
	if (tag === "ul" || tag === "ol") {
		const items = children(node).filter(isElement).filter((child) => child.tagName === "li" && !omitted(child));
		if (isLinkList(items)) return "";
		return block(items.map((item, index) => {
			const marker = tag === "ol" ? `${index + 1}. ` : "- ";
			const lines = render(item, ctx, depth + 1).trim().split("\n");
			return marker + lines.map((line, i) => i && line ? " ".repeat(marker.length) + line : line).join("\n");
		}).join("\n"));
	}
	if (/^h[1-6]$/.test(tag)) {
		const value = renderChildren(node, { ...ctx, plainLinks: true }, depth).trim();
		return block(value && `${"#".repeat(Number(tag[1]))} ${value}`);
	}
	const value = renderChildren(node, ctx, depth);
	if (tag === "a") return renderLink(node, value, ctx);
	if (tag === "strong" || tag === "b") return wrapInline(value, "**");
	if (tag === "em" || tag === "i") return wrapInline(value, "*");
	if (tag === "blockquote") return block(value.trim().split("\n").map((line) => line ? `> ${line}` : ">").join("\n"));
	if (blockTags.test(tag)) return containers.has(tag) || !isLinkBar(node) ? block(value) : "";
	return value;
}

function tidy(content: string): string {
	const output: string[] = [];
	let fence = "";
	for (let line of content.split("\n")) {
		const marker = line.match(/^(`{3,})/)?.[1];
		if (fence) {
			if (marker && marker.length >= fence.length && !line.slice(marker.length).trim()) fence = "";
			output.push(line);
			continue;
		}
		if (marker) fence = marker;
		else if (!line.startsWith("|")) {
			line = line.replace(/(?:[ \t]+\|){2,}/g, " |").replace(/(?:[ \t]+\|)+[ \t]*$/, "");
			if (!line.trim()) line = "";
		}
		if (line || output[output.length - 1]) output.push(line);
	}
	return output.join("\n").trim().replace(/^(?:---\n+)+|(?:\n+---)+$/g, "");
}

// The page title is reported separately, so an H1 that only repeats it is dropped.
function withoutTitleHeading(content: string, title: string): string {
	const heading = content.match(/^# (.+)(?:\n+|$)/m);
	if (!heading || !title.includes(heading[1].replace(/\\(.)/g, "$1").trim())) return content;
	const rest = content.slice(0, heading.index) + content.slice(heading.index! + heading[0].length);
	return rest.trim() ? rest.trim() : content;
}

export function extractPageMarkdown(html: string, url: URL): { title: string; content: string } {
	const document = parse(html);
	let title = "";
	let body: Element | undefined;
	for (const node of elements(document)) {
		if (node.tagName === "title") title ||= rawText(node).replace(/\s+/g, " ").trim();
		if (node.tagName === "body") {
			body = node;
			break;
		}
	}
	if (!body) return { title, content: "" };
	let main: Element | undefined;
	let article: Element | undefined;
	for (const node of elements(body, (node) => !omitted(node))) {
		if (node.tagName === "main" || attr(node, "role") === "main") main ??= node;
		if (node.tagName === "article") article ??= node;
		if (!title && node.tagName === "h1") title = rawText(node).replace(/\s+/g, " ").trim();
	}
	const page = new URL(url);
	page.hash = "";
	const read = (root: Element) => tidy(render(root, { url, page: page.href, images: new Set() }));
	const primary = main ?? article ?? body;
	const content = read(primary) || (primary !== body ? read(body) : "");
	return { title, content: withoutTitleHeading(content, title) };
}
