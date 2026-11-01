import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false });
type Token = ReturnType<typeof markdown.parse>[number];
// Bound serialized HTML too, leaving room for status labels on subsequent edits.
const CHUNK_LIMIT = 3400;
export interface MessageChunk { html: string; plain: string }

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Remove actual service fences, not similarly named text inside ordinary code. */
export function cleanTelegramMarkdown(text: string): string {
	const lines = text.split("\n");
	const hidden = markdown.parse(text, {}).filter((token) => token.type === "fence"
		&& /^(?:pix-actions|pix-html)(?:\s|$)/i.test(token.info.trim()) && token.map);
	for (const token of hidden.reverse()) lines.splice(token.map![0], token.map![1] - token.map![0]);
	return lines.join("\n").trim();
}

/** Telegram's HTML subset only; every chunk has independently balanced tags. */
export function telegramChunks(text: string): MessageChunk[] {
	const chunks: MessageChunk[] = [];
	const stack: Array<{ open: string; close: string }> = [];
	let html = "";
	let plain = "";
	const closing = () => stack.slice().reverse().map((tag) => tag.close).join("");
	const flush = () => {
		if (plain.trim()) chunks.push({ html: html + closing(), plain });
		html = stack.map((tag) => tag.open).join("");
		plain = "";
	};
	const append = (value: string) => {
		for (const character of value) {
			const escaped = escapeHtml(character);
			if (html.length + escaped.length + closing().length > CHUNK_LIMIT) flush();
			html += escaped;
			plain += character;
		}
	};
	const open = (tag: string, end = `</${tag}>`) => {
		const start = `<${tag}>`;
		if (html.length + start.length + closing().length + end.length > CHUNK_LIMIT) flush();
		stack.push({ open: start, close: end });
		html += start;
	};
	const close = () => { html += stack.pop()!.close; };
	const render = (tokens: Token[]) => {
		for (const token of tokens) {
			switch (token.type) {
				case "inline": render(token.children ?? []); break;
				case "text": case "html_inline": case "html_block": append(token.content); break;
				case "softbreak": case "hardbreak": append("\n"); break;
				case "strong_open": case "heading_open": open("b"); break;
				case "em_open": open("i"); break;
				case "s_open": open("s"); break;
				case "blockquote_open": open("blockquote"); break;
				case "strong_close": case "em_close": case "s_close": close(); break;
				case "heading_close": case "blockquote_close": close(); append("\n"); break;
				case "link_open": {
					const href = String(token.attrGet("href") ?? "");
					const escaped = escapeHtml(href);
					// A huge URL must not make an otherwise short message exceed the limit.
					if (/^(?:https?:|mailto:|tg:)/i.test(href) && escaped.length < 1000) open(`a href="${escaped}"`, "</a>");
					else open("u");
					break;
				}
				case "link_close": close(); break;
				case "code_inline": open("code"); append(token.content); close(); break;
				case "code_block": case "fence": open("pre"); append(token.content); close(); append("\n"); break;
				case "paragraph_close": append(token.hidden ? "\n" : "\n\n"); break;
				case "list_item_open": append("• "); break;
				case "image": append(token.content); break;
				case "hr": append("—\n"); break;
				case "th_close": case "td_close": append(" | "); break;
				case "tr_close": append("\n"); break;
			}
		}
	};
	render(markdown.parse(text, {}));
	html = html.trimEnd();
	plain = plain.trimEnd();
	flush();
	return chunks;
}
