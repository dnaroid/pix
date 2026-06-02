import type { ImageContent } from "../../input-editor.js";
import { isRecord } from "../guards.js";

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
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function formatStructuredText(value: unknown): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return "(empty)";
		try {
			return JSON.stringify(JSON.parse(trimmed), null, 2);
		} catch {
			return value;
		}
	}

	return stringifyUnknown(value);
}

export function renderContent(content: readonly unknown[]): string {
	const parts: string[] = [];
	let imageCount = 0;
	for (const item of content) {
		if (!isRecord(item)) {
			parts.push(stringifyUnknown(item));
			continue;
		}

		if (isImageContent(item)) {
			imageCount += 1;
			parts.push(imageContentLabel(item, imageCount));
			continue;
		}

		if (typeof item.text === "string") {
			parts.push(item.text);
			continue;
		}
		if (typeof item.thinking === "string") {
			parts.push(item.thinking);
			continue;
		}
		parts.push(stringifyUnknown(item));
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
