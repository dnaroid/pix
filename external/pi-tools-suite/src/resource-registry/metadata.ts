import { constants, promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseAgentMarkdown } from "../async-subagents/core/agents-dir.js";

/** Edit only the tags field, preserving resource-specific YAML, comments and body. */
function tagField(source: string): { start: number; end: number; newline: string; lines: string[] } {
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const lines = source.split(newline);
	if (lines[0]?.replace(/^\uFEFF/, "").trim() !== "---") throw new Error("Resource requires YAML frontmatter to edit tags.");
	const closing = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
	if (closing < 0) throw new Error("Resource frontmatter is not terminated.");
	const fields = lines.slice(1, closing).flatMap((line, index) => /^tags\s*:/.test(line) ? [index + 1] : []);
	if (fields.length > 1) throw new Error("Duplicate tags field in resource frontmatter.");
	const start = fields[0] ?? closing;
	let end = start;
	if (start < closing) {
		end++;
		while (end < closing && /^(?:\s+\S|-\s|\s*$)/.test(lines[end])) end++;
	}
	return { start, end, newline, lines };
}

export function readResourceTags(source: string): string[] {
	try {
		const { start, end, lines } = tagField(source);
		if (start === end) return [];
		const parsed = parseAgentMarkdown(`---\n${lines.slice(start, end).join("\n")}\n---\n`, "resource tags");
		return (parsed?.frontmatter.tags as string[] | undefined) ?? [];
	} catch {
		// Bad optional metadata must not hide an otherwise usable resource.
		return [];
	}
}

export function normalizeTags(tags: readonly string[]): string[] {
	const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
	if (normalized.length > 32 || normalized.some((tag) => tag.length > 64 || /[,\r\n\x00]/.test(tag))) {
		throw new Error("Use at most 32 tags, each up to 64 characters, without commas or newlines.");
	}
	return normalized;
}

export function writeResourceTags(source: string, tags: readonly string[]): string {
	const { start, end, newline, lines } = tagField(source);
	lines.splice(start, end - start, `tags: ${JSON.stringify(normalizeTags(tags))}`);
	return lines.join(newline);
}

export async function readResourceTagsFile(file: string): Promise<string[]> {
	try { return readResourceTags(await fs.readFile(file, "utf8")); }
	catch { return []; }
}

/** Prefilled editor works consistently in terminal and Desktop extension UI. */
export async function editResourceTags(ctx: ExtensionCommandContext, file: string, title: string): Promise<boolean> {
	if (!ctx.hasUI) throw new Error("Editing tags requires an interactive UI.");
	const parents = [file];
	let parent = dirname(file);
	while (parent !== ctx.cwd && parent !== dirname(parent)) {
		parents.push(parent);
		parent = dirname(parent);
	}
	async function checkLinks(): Promise<void> {
		for (const target of parents) {
			if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Cannot edit tags through a symbolic link.");
		}
	}
	await checkLinks();
	const source = await fs.readFile(file, "utf8");
	const input = await ctx.ui.editor(`${title} (comma-separated; blank clears)`, readResourceTags(source).join(", "));
	if (input === undefined) throw new Error("Tag edit cancelled.");
	const updated = writeResourceTags(source, input.split(","));
	if (updated === source) return false;
	await checkLinks();
	const handle = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW);
	try {
		if (await handle.readFile("utf8") !== source) throw new Error("Resource changed while editing tags. Retry with the current copy.");
		// Write through the checked handle rather than re-opening a replaced pathname.
		await handle.write(updated, 0, "utf8");
		await handle.truncate(Buffer.byteLength(updated));
	} finally { await handle.close(); }
	return true;
}
