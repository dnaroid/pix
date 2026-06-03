import type { ImageContent } from "../input-editor.js";
import { isRecord } from "./guards.js";

const MAX_FORMAT_STRING_CHARS = 256 * 1024;
const MAX_RENDERED_CONTENT_CHARS = 512 * 1024;
const MAX_STRUCTURED_DEPTH = 8;
const MAX_STRUCTURED_ARRAY_ITEMS = 200;
const MAX_STRUCTURED_OBJECT_KEYS = 200;
const TRUNCATED_MARKER = "\n[… truncated …]";

export function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message || value.name;
	if (isRecord(value)) {
		const message = typeof value.message === "string" ? value.message : undefined;
		const name = typeof value.name === "string" ? value.name : undefined;
		if (message) return name && name !== "Error" ? `${name}: ${message}` : message;
		if (name) return name;
	}
	try {
		return JSON.stringify(normalizeStructuredValue(value), null, 2);
	} catch {
		return String(value);
	}
}

export function formatStructuredText(value: unknown): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return "(empty)";
		if (trimmed.length > MAX_FORMAT_STRING_CHARS) return truncateText(value, MAX_FORMAT_STRING_CHARS);
		try {
			return JSON.stringify(normalizeStructuredValue(JSON.parse(trimmed)), null, 2);
		} catch {
			return value;
		}
	}

	return stringifyUnknown(value);
}

export function renderContent(content: readonly unknown[]): string {
	const parts: string[] = [];
	let imageCount = 0;
	let renderedChars = 0;
	const pushPart = (part: string): boolean => {
		const remaining = MAX_RENDERED_CONTENT_CHARS - renderedChars;
		if (remaining <= 0) return false;
		const next = part.length > remaining ? truncateText(part, remaining) : part;
		parts.push(next);
		renderedChars += next.length;
		return part.length <= remaining;
	};
	for (const item of content) {
		if (!isRecord(item)) {
			if (!pushPart(stringifyUnknown(item))) break;
			continue;
		}

		if (isImageContent(item)) {
			imageCount += 1;
			if (!pushPart(imageContentLabel(item, imageCount))) break;
			continue;
		}

		if (typeof item.text === "string") {
			if (!pushPart(item.text)) break;
			continue;
		}
		if (typeof item.thinking === "string") {
			if (!pushPart(item.thinking)) break;
			continue;
		}
		if (!pushPart(stringifyUnknown(item))) break;
	}
	return parts.join("\n");
}

export function renderUserMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return stringifyUnknown(content);

	const textParts: string[] = [];
	let imageCount = 0;
	for (const item of content) {
		if (!isRecord(item)) {
			textParts.push(stringifyUnknown(item));
			continue;
		}

		if (item.type === "image") {
			imageCount += 1;
			continue;
		}
		if (typeof item.text === "string") {
			textParts.push(item.text);
			continue;
		}
		textParts.push(stringifyUnknown(item));
	}

	const text = textParts.join("\n").replace(/\[Image \d+(?:: [^\]]+)?\]/g, "").trimEnd();
	if (imageCount === 0) return text;

	const imageText = userImageLabels(imageCount);
	return text ? `${text}\n${imageText}` : imageText;
}

export function extractImageContents(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter(isImageContent);
}

export function isImageContent(item: unknown): item is ImageContent {
	return isRecord(item) && item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string";
}

function imageContentLabel(item: ImageContent, index: number): string {
	const label = index === 1 ? "Image" : `Image ${index}`;
	return `[${label}: ${item.mimeType}]`;
}

function userImageLabels(count: number): string {
	if (count <= 0) return "";
	if (count === 1) return "[Image]";
	return Array.from({ length: count }, (_, index) => `[Image ${index + 1}]`).join("\n");
}

export function submittedUserDisplayText(displayText: string, promptText: string, images: readonly ImageContent[]): string {
	const trimmedDisplay = displayText.trimEnd();
	if (trimmedDisplay) return trimmedDisplay;
	if (images.length > 0) return userImageLabels(images.length);
	return promptText.trimEnd();
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars))}${TRUNCATED_MARKER}`;
}

function normalizeStructuredValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return truncateText(value, MAX_FORMAT_STRING_CHARS);
	if (!value || typeof value !== "object") return value;
	if (depth >= MAX_STRUCTURED_DEPTH) return "[… truncated: depth limit …]";
	if (seen.has(value)) return "[… circular …]";
	seen.add(value);
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_STRUCTURED_ARRAY_ITEMS).map((item) => normalizeStructuredValue(item, depth + 1, seen));
		if (value.length > MAX_STRUCTURED_ARRAY_ITEMS) items.push(`[… ${value.length - MAX_STRUCTURED_ARRAY_ITEMS} more items …]`);
		return items;
	}
	if (value instanceof Error) return value.message || value.name;

	const output: Record<string, unknown> = {};
	let count = 0;
	for (const [key, child] of Object.entries(value)) {
		if (count >= MAX_STRUCTURED_OBJECT_KEYS) {
			output["…"] = "truncated: object key limit";
			break;
		}
		output[key] = normalizeStructuredValue(child, depth + 1, seen);
		count += 1;
	}
	return output;
}
