import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resizeImage } from "@earendil-works/pi-coding-agent";

export interface ClipboardImage {
	/** Base64-encoded image data. */
	data: string;
	mimeType: string;
}

type ClipboardModule = {
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number> | Uint8Array>;
};

type ClipboardRequire = (id: string) => unknown;

const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);

function loadClipboardNative(requires: readonly ClipboardRequire[] = [moduleRequire, executableDirRequire]): ClipboardModule | null {
	for (const requireClipboard of requires) {
		try {
			return requireClipboard("@mariozechner/clipboard") as ClipboardModule;
		} catch {
			// Try the next resolution root. This mirrors pi's packaged-binary fallback,
			// where native sidecars may resolve relative to the executable directory.
		}
	}
	return null;
}

const nativeClipboard = !process.env.TERMUX_VERSION && (process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY))
	? loadClipboardNative()
	: null;

/**
 * Read an image from the system clipboard.
 * Uses the native @mariozechner/clipboard N-API module for direct clipboard
 * access. Works on macOS, Windows, and Linux (X11/Wayland).
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
	try {
		if (!nativeClipboard?.hasImage()) return null;

		const bytes = await nativeClipboard.getImageBinary();
		if (!bytes || bytes.length === 0) return null;

		const uint8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);

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
