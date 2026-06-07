/**
 * Minimal markdown → Telegram HTML conversion.
 *
 * Telegram supports a small subset of HTML: <b>, <i>, <code>, <pre>, <a>, <s>, <u>.
 * See https://core.telegram.org/bots/api#html-style
 *
 * We escape < > & first, then re-introduce supported tags from common markdown
 * patterns. This is intentionally lossy — blockquotes, headings, lists render
 * as plain text. The goal is to keep streaming output legible on a phone screen.
 */

const ENTITY_RE = /[<>&]/g;

export function escapeHtml(value: string): string {
	return value.replace(ENTITY_RE, (ch) => {
		switch (ch) {
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case "&":
				return "&amp;";
			default:
				return ch;
		}
	});
}

/**
 * Convert a chunk of assistant-flavoured markdown to Telegram HTML.
 *
 * Handles:
 *   ```lang\nfenced\n```   → <pre><code class="language-lang">…</code></pre>
 *   `inline code`          → <code>…</code>
 *   **bold**               → <b>…</b>
 *   __bold__ / *italic*    → <b>…</b> / <i>…</i>
 *
 * Everything else is HTML-escaped.
 */
export function markdownToTelegram(value: string): string {
	if (!value) return "";

	// Pull out fenced code blocks first so their contents aren't mangled
	// by inline replacements.
	const fences: string[] = [];
	const fenced = value.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, lang, body) => {
		const langAttr = typeof lang === "string" && lang.trim() ? ` class="language-${escapeHtml(lang.trim())}"` : "";
		const rendered = `<pre><code${langAttr}>${escapeHtml(body)}</code></pre>`;
		fences.push(rendered);
		return `\u0000FENCE${fences.length - 1}\u0000`;
	});

	let out = escapeHtml(fenced);

	// Inline code (do before bold/italic so backticks inside ** stay escaped)
	out = out.replace(/`([^`\n]+?)`/g, (_m, code) => `<code>${code}</code>`);

	// Bold
	out = out.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
	out = out.replace(/__([^_\n]+?)__/g, "<b>$1</b>");

	// Italic (single * or _)
	out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>");
	out = out.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1<i>$2</i>");

	// Restore fenced blocks
	out = out.replace(/\u0000FENCE(\d+)\u0000/g, (_m, idx) => fences[Number(idx)] ?? "");

	return out;
}

/** Telegram message size limit. */
export const TELEGRAM_MESSAGE_MAX = 4096;

/**
 * Split a rendered HTML payload into chunks that fit a single Telegram message.
 * Tries to break on blank lines first, then on newlines, then hard-splits.
 *
 * Each chunk is guaranteed to be <= maxChars characters.
 */
export function chunkForTelegram(html: string, maxChars = TELEGRAM_MESSAGE_MAX): string[] {
	if (html.length <= maxChars) return [html];

	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < html.length) {
		const remaining = html.length - cursor;
		if (remaining <= maxChars) {
			chunks.push(html.slice(cursor));
			break;
		}

		const window = html.slice(cursor, cursor + maxChars);
		let cut = -1;

		// Prefer blank line break
		const blank = window.lastIndexOf("\n\n");
		if (blank >= maxChars * 0.5) cut = blank + 1;

		// Then any newline
		if (cut < 0) {
			const nl = window.lastIndexOf("\n");
			if (nl >= maxChars * 0.5) cut = nl + 1;
		}

		// Then a space
		if (cut < 0) {
			const sp = window.lastIndexOf(" ");
			if (sp >= maxChars * 0.5) cut = sp + 1;
		}

		// Hard cut
		if (cut < 0) cut = maxChars;

		chunks.push(html.slice(cursor, cursor + cut));
		cursor += cut;
	}

	return chunks.filter((chunk) => chunk.length > 0);
}
