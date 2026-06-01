import { resizeImage } from "@earendil-works/pi-coding-agent";
import { hasImage, getImageBinary } from "@mariozechner/clipboard";

export interface ClipboardImage {
	/** Base64-encoded image data. */
	data: string;
	mimeType: string;
}

/**
 * Read an image from the system clipboard.
 * Uses the native @mariozechner/clipboard N-API module for direct clipboard
 * access. Works on macOS, Windows, and Linux (X11/Wayland).
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
	try {
		if (!hasImage()) return null;

		const bytes = await getImageBinary();
		if (!bytes || bytes.length === 0) return null;

		const uint8 = new Uint8Array(bytes);

		try {
			const resized = await resizeImage(uint8, "image/png", { maxWidth: 2000, maxHeight: 2000 });
			if (resized) return { data: resized.data, mimeType: resized.mimeType };
		} catch { /* resize failed, use original */ }

		return { data: Buffer.from(uint8).toString("base64"), mimeType: "image/png" };
	} catch {
		return null;
	}
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

export function isImagePath(filePath: string): boolean {
	const ext = filePath.toLowerCase().split(".").pop();
	return ext ? IMAGE_EXTENSIONS.has(`.${ext}`) : false;
}

export function imageMimeTypeForPath(filePath: string): string {
	const ext = `.${filePath.toLowerCase().split(".").pop() ?? ""}`;
	return IMAGE_MIME_TYPES[ext] ?? "application/octet-stream";
}

export function quoteFilePathForInput(filePath: string): string {
	return `"${filePath.replace(/"/g, '\\"')}"`;
}

export function looksLikeFilePath(text: string): string | null {
	const trimmed = text.trim().replace(/^["']+|["']+$/g, "");
	if (trimmed.startsWith("file://")) {
		try { return new URL(trimmed).pathname; } catch { return null; }
	}
	if (/^\/[^\0]+$/.test(trimmed) || /^\.{0,2}\/[^\0]+$/.test(trimmed) || /^[A-Za-z]:\\[^\0]+$/.test(trimmed)) {
		return trimmed;
	}
	return null;
}
