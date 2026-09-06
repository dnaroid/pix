import { open, stat } from "node:fs/promises";
import type { PiAgentMessage } from "../pi/pi-rpc-client.js";

// Keep these aligned with the TUI lazy session manager. Opening a conversation
// should inspect a bounded tail instead of parsing the whole JSONL session.
const DEFAULT_TAIL_ENTRY_COUNT = 180;
const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

export interface PersistedToolResultRef {
	readonly sessionPath: string;
	readonly offset: number;
	readonly byteLength: number;
}

export interface PersistedImageRef extends PersistedToolResultRef {
	readonly imageIndex: number;
	readonly mimeType: string;
}

export const DEFERRED_PERSISTED_IMAGE_PREFIX = "pix-deferred-image:";

export interface PersistedHistoryTail {
	readonly messages: readonly PiAgentMessage[];
	readonly toolResultRefs: ReadonlyMap<string, PersistedToolResultRef>;
	readonly imageRefs: ReadonlyMap<string, PersistedImageRef>;
}

interface ParsedTailEntry {
	readonly offset: number;
	readonly byteLength: number;
	readonly message?: PiAgentMessage;
	readonly imageRefs?: ReadonlyMap<string, PersistedImageRef>;
	readonly toolResult?: {
		readonly toolCallId: string;
		readonly isError: boolean;
	};
}

/**
 * Read the same bounded tail strategy used by the TUI, but deliberately avoid
 * JSON.parse for tool-result lines. Large tool bodies remain raw bytes on disk
 * until Desktop expands that tool.
 */
export async function readPersistedHistoryTail(
	sessionPath: string,
	limit = DEFAULT_TAIL_ENTRY_COUNT,
): Promise<PersistedHistoryTail | undefined> {
	const size = await stat(sessionPath).then((result) => result.size).catch(() => undefined);
	if (size === undefined) return undefined;
	if (size <= 0) return { messages: [], toolResultRefs: new Map(), imageRefs: new Map() };

	const targetCount = Math.max(1, Math.floor(limit));
	let byteCount = Math.min(size, INITIAL_TAIL_BYTES);
	const maxBytes = Math.min(size, MAX_TAIL_BYTES);
	let parsed: ParsedTailEntry[] = [];

	while (byteCount <= maxBytes) {
		parsed = await readTailEntries(sessionPath, size, byteCount);
		if (parsed.length >= targetCount || byteCount >= maxBytes || byteCount >= size) break;
		byteCount = Math.min(size, Math.max(byteCount + 1, byteCount * 2));
	}

	const selected = parsed.slice(-targetCount);
	const messages: PiAgentMessage[] = [];
	const toolResultRefs = new Map<string, PersistedToolResultRef>();
	const imageRefs = new Map<string, PersistedImageRef>();
	for (const entry of selected) {
		if (entry.toolResult) {
			messages.push({
				role: "toolResult",
				toolCallId: entry.toolResult.toolCallId,
				isError: entry.toolResult.isError,
				content: [],
			} as unknown as PiAgentMessage);
			toolResultRefs.set(entry.toolResult.toolCallId, {
				sessionPath,
				offset: entry.offset,
				byteLength: entry.byteLength,
			});
		} else if (entry.message) {
			messages.push(entry.message);
			for (const [imageId, imageRef] of entry.imageRefs ?? []) {
				imageRefs.set(imageId, { ...imageRef, sessionPath });
			}
		}
	}
	return { messages, toolResultRefs, imageRefs };
}

/** Materialize one previously deferred tool-result line only on expansion. */
export async function readPersistedToolResult(ref: PersistedToolResultRef): Promise<PiAgentMessage | undefined> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(ref.sessionPath, "r");
		const buffer = Buffer.alloc(ref.byteLength);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, ref.offset);
		const parsed = JSON.parse(buffer.toString("utf8", 0, bytesRead)) as unknown;
		if (!isRecord(parsed) || parsed.type !== "message" || !isRecord(parsed.message)) return undefined;
		return parsed.message as unknown as PiAgentMessage;
	} catch {
		return undefined;
	} finally {
		await file?.close();
	}
}

/** Read one deferred user-image body without parsing the surrounding JSONL message. */
export async function readPersistedImage(ref: PersistedImageRef): Promise<{ data: string; mimeType: string } | undefined> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(ref.sessionPath, "r");
		const buffer = Buffer.alloc(ref.byteLength);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, ref.offset);
		const images = persistedImageRanges(buffer.subarray(0, bytesRead));
		const image = images[ref.imageIndex];
		if (!image || image.mimeType !== ref.mimeType) return undefined;
		return {
			data: buffer.toString("ascii", image.dataStart, image.dataEnd),
			mimeType: image.mimeType,
		};
	} catch {
		return undefined;
	} finally {
		await file?.close();
	}
}

async function readTailEntries(sessionPath: string, size: number, byteCount: number): Promise<ParsedTailEntry[]> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const start = Math.max(0, size - byteCount);
		const buffer = Buffer.alloc(size - start);
		file = await open(sessionPath, "r");
		await file.read(buffer, 0, buffer.length, start);

		let parseStart = 0;
		if (start > 0) {
			const firstNewline = buffer.indexOf(10);
			parseStart = firstNewline >= 0 ? firstNewline + 1 : buffer.length;
		}
		return parseEntryLines(buffer.subarray(parseStart), start + parseStart);
	} catch {
		return [];
	} finally {
		await file?.close();
	}
}

function parseEntryLines(buffer: Buffer, baseOffset: number): ParsedTailEntry[] {
	const entries: ParsedTailEntry[] = [];
	let lineStart = 0;
	for (let index = 0; index <= buffer.length; index += 1) {
		if (index < buffer.length && buffer[index] !== 10) continue;
		const lineEnd = index > lineStart && buffer[index - 1] === 13 ? index - 1 : index;
		const byteLength = lineEnd - lineStart;
		if (byteLength > 0) {
			const entry = parseEntryLine(buffer.subarray(lineStart, lineEnd), baseOffset + lineStart, byteLength);
			if (entry) entries.push(entry);
		}
		lineStart = index + 1;
	}
	return entries;
}

function parseEntryLine(lineBuffer: Buffer, offset: number, byteLength: number): ParsedTailEntry | undefined {
	const deferredUserMessage = compactUserMessageWithoutImageBodies(lineBuffer, offset, byteLength);
	if (deferredUserMessage) return deferredUserMessage;
	const line = lineBuffer.toString("utf8");
	if (!looksLikeMessageEntry(line)) {
		try {
			const parsed = JSON.parse(line) as unknown;
			if (!isRecord(parsed) || parsed.type === "session" || typeof parsed.id !== "string") return undefined;
			return { offset, byteLength };
		} catch {
			return undefined;
		}
	}

	if (looksLikeToolResult(line)) {
		const toolCallId = jsonStringField(line, "toolCallId");
		if (!toolCallId) return undefined;
		return {
			offset,
			byteLength,
			toolResult: { toolCallId, isError: /"isError"\s*:\s*true/u.test(line) },
		};
	}

	try {
		const parsed = JSON.parse(line) as unknown;
		if (!isRecord(parsed) || parsed.type !== "message" || !isRecord(parsed.message)) return undefined;
		return { offset, byteLength, message: parsed.message as unknown as PiAgentMessage };
	} catch {
		return undefined;
	}
}

interface PersistedImageRange {
	readonly dataStart: number;
	readonly dataEnd: number;
	readonly mimeType: string;
}

const ROLE_USER_BYTES = Buffer.from('"role":"user"');
const IMAGE_TYPE_BYTES = Buffer.from('"type":"image"');
const IMAGE_DATA_BYTES = Buffer.from('"data":"');
const IMAGE_MIME_BYTES = Buffer.from('"mimeType":"');

function compactUserMessageWithoutImageBodies(
	line: Buffer,
	offset: number,
	byteLength: number,
): ParsedTailEntry | undefined {
	if (line.indexOf(ROLE_USER_BYTES) < 0 || line.indexOf(IMAGE_TYPE_BYTES) < 0) return undefined;
	const images = persistedImageRanges(line);
	if (images.length === 0) return undefined;

	let cursor = 0;
	const compact: string[] = [];
	const imageRefs = new Map<string, PersistedImageRef>();
	for (const [imageIndex, image] of images.entries()) {
		const imageId = `${DEFERRED_PERSISTED_IMAGE_PREFIX}${offset}:${imageIndex}`;
		compact.push(line.toString("utf8", cursor, image.dataStart), imageId);
		cursor = image.dataEnd;
		imageRefs.set(imageId, {
			sessionPath: "",
			offset,
			byteLength,
			imageIndex,
			mimeType: image.mimeType,
		});
	}
	compact.push(line.toString("utf8", cursor));

	try {
		const parsed = JSON.parse(compact.join("")) as unknown;
		if (!isRecord(parsed) || parsed.type !== "message" || !isRecord(parsed.message)) return undefined;
		return { offset, byteLength, message: parsed.message as unknown as PiAgentMessage, imageRefs };
	} catch {
		return undefined;
	}
}

function persistedImageRanges(line: Buffer): PersistedImageRange[] {
	const ranges: PersistedImageRange[] = [];
	let searchFrom = 0;
	while (searchFrom < line.length) {
		const imageType = line.indexOf(IMAGE_TYPE_BYTES, searchFrom);
		if (imageType < 0) break;
		const objectEnd = line.indexOf(125, imageType); // }
		if (objectEnd < 0) break;
		const dataField = line.indexOf(IMAGE_DATA_BYTES, imageType + IMAGE_TYPE_BYTES.length);
		if (dataField < 0 || dataField > objectEnd) {
			searchFrom = objectEnd + 1;
			continue;
		}
		const dataStart = dataField + IMAGE_DATA_BYTES.length;
		const dataEnd = line.indexOf(34, dataStart); // " -- base64 itself cannot contain quotes.
		if (dataEnd < 0 || dataEnd > objectEnd) break;
		const mimeField = line.indexOf(IMAGE_MIME_BYTES, dataEnd);
		if (mimeField < 0 || mimeField > objectEnd) {
			searchFrom = objectEnd + 1;
			continue;
		}
		const mimeStart = mimeField + IMAGE_MIME_BYTES.length;
		const mimeEnd = line.indexOf(34, mimeStart);
		if (mimeEnd < 0 || mimeEnd > objectEnd) break;
		ranges.push({ dataStart, dataEnd, mimeType: line.toString("utf8", mimeStart, mimeEnd) });
		searchFrom = objectEnd + 1;
	}
	return ranges;
}

function looksLikeMessageEntry(line: string): boolean {
	return /"type"\s*:\s*"message"/u.test(line) && /"message"\s*:/u.test(line);
}

function looksLikeToolResult(line: string): boolean {
	return /"role"\s*:\s*"toolResult"/u.test(line);
}

function jsonStringField(line: string, key: string): string | undefined {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const match = new RegExp(`"${escapedKey}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "u").exec(line);
	if (!match?.[1]) return undefined;
	try {
		const value = JSON.parse(match[1]) as unknown;
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
