import { parse } from "parse5";

import { elementAttr, elementText, findElement, hasClass, htmlElements, type HtmlElement } from "./html-dom.js";

// Keyless search: DuckDuckGo's plain-HTML results endpoint, parsed locally.
// The endpoint answers GET requests only (POST returns a JS challenge), so the
// transport below always issues GETs.
export const DDG_SEARCH_HOST = "https://html.duckduckgo.com";

export const DDG_SEARCH_HEADERS: Record<string, string> = {
	"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
	"Accept-Language": "en-US,en;q=0.9",
};

export interface DdgResult {
	title: string;
	url: string;
	content: string;
}

export function ddgSearchUrl(query: string): string {
	return `${DDG_SEARCH_HOST}/html/?${new URLSearchParams({ q: query })}`;
}

/** Resolves DDG redirect wrappers (`//duckduckgo.com/l/?uddg=<encoded>`) to the target URL. */
function resolveDdgTarget(href: string): string | undefined {
	if (/^https?:\/\//i.test(href)) return href;
	if (!href.startsWith("//")) return undefined;
	const url = URL.parse(`https:${href}`);
	if (!url || url.hostname !== "duckduckgo.com" || url.pathname !== "/l/") return undefined;
	const target = URL.parse(url.searchParams.get("uddg") ?? "");
	return target && /^https?:$/.test(target.protocol) ? target.toString() : undefined;
}

function resultFromBlock(block: HtmlElement): DdgResult | undefined {
	const link = findElement(block, (element) => element.tagName === "a" && hasClass(element, "result__a"));
	if (!link) return undefined;
	const url = resolveDdgTarget(elementAttr(link, "href") ?? "");
	if (!url) return undefined;
	const snippet = findElement(block, (element) => hasClass(element, "result__snippet"));
	return {
		title: elementText(link) || "Untitled",
		url,
		content: snippet ? elementText(snippet) : "",
	};
}

/**
 * Extracts organic web results from a DuckDuckGo HTML results page. Throws when the page is not a
 * recognizable results page (challenge, block page or changed layout) so callers report a failure
 * instead of a silent empty result.
 */
export function parseDdgSearchHtml(html: string): DdgResult[] {
	const document = parse(html);
	const results: DdgResult[] = [];
	const seen = new Set<string>();
	let recognized = false;

	for (const element of htmlElements(document)) {
		if (hasClass(element, "serp__results") || (elementAttr(element, "id") === "links" && hasClass(element, "results"))) recognized = true;
		if (element.tagName !== "div" || !hasClass(element, "result")) continue;
		if (hasClass(element, "result--ad")) continue;
		if (hasClass(element, "result--no-results")) {
			recognized = true;
			continue;
		}
		const result = resultFromBlock(element);
		if (!result || seen.has(result.url)) continue;
		seen.add(result.url);
		results.push(result);
	}

	if (!recognized) throw new Error("DuckDuckGo Search returned an unrecognized page (possible CAPTCHA or layout change).");
	return results;
}
