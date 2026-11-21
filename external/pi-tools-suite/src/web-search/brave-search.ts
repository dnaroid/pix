import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5";

// Keyless last-resort search: Brave Search public HTML results page, parsed locally.
export const BRAVE_SEARCH_HOST = "https://search.brave.com";

export const BRAVE_SEARCH_HEADERS: Record<string, string> = {
	"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
	"Accept-Language": "en-US,en;q=0.9",
};

export interface BraveResult {
	title: string;
	url: string;
	content: string;
}

type Node = Tree.Node;
type Element = Tree.Element;

export function braveSearchUrl(query: string): string {
	return `${BRAVE_SEARCH_HOST}/search?${new URLSearchParams({ q: query, source: "web" })}`;
}

function isElement(node: Node): node is Element {
	return "tagName" in node;
}

function attr(node: Element, name: string): string | undefined {
	return node.attrs.find((item) => item.name === name)?.value;
}

function hasClass(node: Element, name: string): boolean {
	return (attr(node, "class") ?? "").split(/\s+/).includes(name);
}

function* elements(root: Node): Generator<Element> {
	const pending = [root];
	while (pending.length) {
		const node = pending.pop()!;
		if (isElement(node)) yield node;
		const nested = "childNodes" in node ? node.childNodes : [];
		for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]);
	}
}

function find(root: Node, match: (element: Element) => boolean): Element | undefined {
	for (const element of elements(root)) if (element !== root && match(element)) return element;
	return undefined;
}

function text(node: Node): string {
	const parts: string[] = [];
	for (const pending = [node]; pending.length;) {
		const current = pending.pop()!;
		if ("value" in current) parts.push(current.value);
		if (isElement(current) && (current.tagName === "script" || current.tagName === "style")) continue;
		const nested = "childNodes" in current ? current.childNodes : [];
		for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]);
	}
	return parts.join("").replace(/\s+/g, " ").trim();
}

function resultFromSnippet(snippet: Element): BraveResult | undefined {
	const link = find(snippet, (element) => element.tagName === "a" && /^https?:\/\//i.test(attr(element, "href") ?? ""));
	if (!link) return undefined;
	const url = attr(link, "href")!;
	if (URL.parse(url)?.hostname.endsWith("brave.com")) return undefined;

	const titleElement = find(snippet, (element) => hasClass(element, "title"));
	const title = (titleElement && (attr(titleElement, "title")?.trim() || text(titleElement))) || text(link) || "Untitled";
	const description = find(snippet, (element) => hasClass(element, "generic-snippet") || hasClass(element, "snippet-description"));
	return { title, url, content: description ? text(description) : "" };
}

/**
 * Extracts organic web results from a Brave Search HTML page. Throws when the page is not a
 * recognizable results page (CAPTCHA, block page or changed layout) so callers report a failure
 * instead of a silent empty result.
 */
export function parseBraveSearchHtml(html: string): BraveResult[] {
	const document = parse(html);
	const results: BraveResult[] = [];
	const seen = new Set<string>();
	let recognized = false;

	for (const element of elements(document)) {
		if (attr(element, "id") === "mixed-main" || attr(element, "id") === "results") recognized = true;
		if (attr(element, "data-type") !== "web" || !hasClass(element, "snippet")) continue;
		recognized = true;
		const result = resultFromSnippet(element);
		if (!result || seen.has(result.url)) continue;
		seen.add(result.url);
		results.push(result);
	}

	if (!recognized) throw new Error("Brave Search returned an unrecognized page (possible CAPTCHA or layout change).");
	return results;
}
