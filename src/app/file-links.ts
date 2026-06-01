import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type RenderedLink = {
	start: number;
	end: number;
	url: string;
	filePath?: string;
	line?: number | undefined;
	column?: number | undefined;
};

const FILE_PATH_CANDIDATE = /(?<![\p{L}\p{N}_:])((?:file:\/\/\/|~\/|\.{1,2}\/|\/|[A-Za-z0-9_.@-]+\/)[^\s"'`<>]*)/gu;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ")", "]", "}"]);

export function detectFileLinks(text: string, cwd: string | undefined): RenderedLink[] {
	const links: RenderedLink[] = [];
	if (!text.includes("/")) return links;

	for (const match of text.matchAll(FILE_PATH_CANDIDATE)) {
		const raw = match[1];
		if (!raw) continue;

		const start = match.index + match[0].indexOf(raw);
		const candidate = trimTrailingPunctuation(raw);
		if (!candidate) continue;

		const location = resolveExistingFileLocation(candidate, cwd);
		if (!location) continue;

		links.push({
			start,
			end: start + candidate.length,
			url: locationUrl(location),
			filePath: location.filePath,
			line: location.line,
			column: location.column,
		});
	}

	return mergeOverlappingLinks(links);
}

export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function locationUrl(location: { filePath: string; line?: number | undefined; column?: number | undefined }): string {
	const url = pathToFileURL(location.filePath).href;
	if (location.line === undefined) return url;
	return location.column === undefined ? `${url}:${location.line}` : `${url}:${location.line}:${location.column}`;
}

function trimTrailingPunctuation(value: string): string {
	let end = value.length;
	while (end > 0 && TRAILING_PUNCTUATION.has(value[end - 1] ?? "")) end -= 1;
	return value.slice(0, end);
}

function resolveExistingFileLocation(candidate: string, cwd: string | undefined): { filePath: string; line?: number | undefined; column?: number | undefined } | undefined {
	for (const variant of candidatePathVariants(candidate)) {
		const filePath = resolveLocalPath(variant.pathText, cwd);
		if (filePath && isExistingFile(filePath)) return { filePath, line: variant.line, column: variant.column };
	}
	return undefined;
}

function candidatePathVariants(candidate: string): { pathText: string; line?: number | undefined; column?: number | undefined }[] {
	const variants: { pathText: string; line?: number | undefined; column?: number | undefined }[] = [{ pathText: candidate }];
	const locationSuffix = /^(.*?):(\d+)(?::(\d+))?(?:\+\d+)?$/u.exec(candidate);
	if (locationSuffix?.[1] && locationSuffix[1] !== candidate) {
		variants.push({
			pathText: locationSuffix[1],
			line: Number(locationSuffix[2]),
			column: locationSuffix[3] ? Number(locationSuffix[3]) : undefined,
		});
	}

	const markdownAnchorSuffix = /^(.*?)#L(\d+)(?:C(\d+))?$/u.exec(candidate);
	if (markdownAnchorSuffix?.[1] && markdownAnchorSuffix[1] !== candidate) {
		variants.push({
			pathText: markdownAnchorSuffix[1],
			line: Number(markdownAnchorSuffix[2]),
			column: markdownAnchorSuffix[3] ? Number(markdownAnchorSuffix[3]) : undefined,
		});
	}

	const seen = new Set<string>();
	return variants.filter((variant) => {
		const key = `${variant.pathText}\0${variant.line ?? ""}\0${variant.column ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function resolveLocalPath(pathText: string, cwd: string | undefined): string | undefined {
	if (pathText.startsWith("file:///")) {
		try {
			return fileURLToPath(pathText);
		} catch {
			return undefined;
		}
	}

	if (pathText.startsWith("~/")) return resolve(homedir(), pathText.slice(2));
	if (isAbsolute(pathText)) return pathText;
	if (!cwd) return undefined;
	return resolve(cwd, pathText);
}

function isExistingFile(filePath: string): boolean {
	try {
		return existsSync(filePath) && statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function mergeOverlappingLinks(links: RenderedLink[]): RenderedLink[] {
	const merged: RenderedLink[] = [];
	for (const link of links.sort((left, right) => left.start - right.start || right.end - left.end)) {
		const previous = merged[merged.length - 1];
		if (previous && link.start < previous.end) continue;
		merged.push(link);
	}
	return merged;
}
