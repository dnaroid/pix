import type { DefaultTreeAdapterTypes as Tree } from "parse5";

export type HtmlNode = Tree.Node;
export type HtmlElement = Tree.Element;

export function isElement(node: HtmlNode): node is HtmlElement {
	return "tagName" in node;
}

export function elementAttr(node: HtmlElement, name: string): string | undefined {
	return node.attrs.find((item) => item.name === name)?.value;
}

export function hasClass(node: HtmlElement, name: string): boolean {
	return (elementAttr(node, "class") ?? "").split(/\s+/).includes(name);
}

export function* htmlElements(root: HtmlNode): Generator<HtmlElement> {
	const pending = [root];
	while (pending.length) {
		const node = pending.pop()!;
		if (isElement(node)) yield node;
		const nested = "childNodes" in node ? node.childNodes : [];
		for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]);
	}
}

export function findElement(root: HtmlNode, match: (element: HtmlElement) => boolean): HtmlElement | undefined {
	for (const element of htmlElements(root)) if (element !== root && match(element)) return element;
	return undefined;
}

export function elementText(node: HtmlNode): string {
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
