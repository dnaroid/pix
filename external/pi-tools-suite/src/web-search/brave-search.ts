import { parse } from "parse5";

import { elementAttr, elementText, findElement, hasClass, htmlElements, type HtmlElement } from "./html-dom.js";

// Keyless search: Brave Search public HTML results page, parsed locally.
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

export function braveSearchUrl(query: string): string {
	return `${BRAVE_SEARCH_HOST}/search?${new URLSearchParams({ q: query, source: "web" })}`;
}

function resultFromSnippet(snippet: HtmlElement): BraveResult | undefined {
	const link = findElement(snippet, (element) => element.tagName === "a" && /^https?:\/\//i.test(elementAttr(element, "href") ?? ""));
	if (!link) return undefined;
	const url = elementAttr(link, "href")!;
	if (URL.parse(url)?.hostname.endsWith("brave.com")) return undefined;

	const titleElement = findElement(snippet, (element) => hasClass(element, "title"));
	const title = (titleElement && (elementAttr(titleElement, "title")?.trim() || elementText(titleElement))) || elementText(link) || "Untitled";
	const description = findElement(snippet, (element) => hasClass(element, "generic-snippet") || hasClass(element, "snippet-description"));
	return { title, url, content: description ? elementText(description) : "" };
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

	for (const element of htmlElements(document)) {
		if (elementAttr(element, "id") === "mixed-main" || elementAttr(element, "id") === "results") recognized = true;
		if (elementAttr(element, "data-type") !== "web" || !hasClass(element, "snippet")) continue;
		recognized = true;
		const result = resultFromSnippet(element);
		if (!result || seen.has(result.url)) continue;
		seen.add(result.url);
		results.push(result);
	}

	if (!recognized) throw new Error("Brave Search returned an unrecognized page (possible CAPTCHA or layout change).");
	return results;
}
