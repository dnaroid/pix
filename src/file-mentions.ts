/** Shared, browser-safe mention syntax. Contents are never read or attached. */
export interface FileMentionMatch { path: string; directory: boolean }
export interface FileMentionQuery { start: number; end: number; query: string }

export function fileMentionQuery(text: string, start: number, end = start): FileMentionQuery | undefined {
	if (start !== end || text.trimStart().startsWith("/") || text.trimStart().startsWith("!")) return;
	const match = /(?:^|\s)@([^\s"]*)$/.exec(text.slice(0, start));
	if (!match || match[1] === undefined || match[1].length > 256) return;
	return { start: start - match[1].length - 1, end: start, query: match[1] };
}

export function fileMentionToken(path: string): string {
	return /[\s"\\@]/u.test(path) ? `@${JSON.stringify(path)}` : `@${path}`;
}

export function insertFileMention(text: string, query: FileMentionQuery, path: string): { text: string; cursor: number } {
	const token = `${fileMentionToken(path)} `;
	return { text: text.slice(0, query.start) + token + text.slice(query.end), cursor: query.start + token.length };
}

export function fileMentionTokens(text: string): { path: string; start: number; end: number }[] {
	const tokens: { path: string; start: number; end: number }[] = [];
	for (const match of text.matchAll(/(?:^|\s)(@(?:"(?:[^"\\]|\\.)*"|[^\s"]+))(?=\s|$)/gu)) {
		const token = match[1]!;
		let path = token.slice(1);
		if (path.startsWith('"')) {
			try { path = JSON.parse(path) as string; } catch { continue; }
		}
		const start = match.index + match[0].length - token.length;
		tokens.push({ path, start, end: start + token.length });
	}
	return tokens;
}
