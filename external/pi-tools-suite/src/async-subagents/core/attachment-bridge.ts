import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRunRoot } from "./paths.js";

export interface BridgedImageAttachment {
	absolutePath: string;
	relativePath: string;
	mimeType: string;
}

export interface BridgeImageAttachmentsResult {
	attachments: BridgedImageAttachment[];
	skipped: number;
	error?: string;
}

const ATTACHMENT_DIR = "attachments";
const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function bridgeImageAttachments(cwd: string, event: unknown): BridgeImageAttachmentsResult {
	const images = extractImageContents(event);
	if (images.length === 0) return { attachments: [], skipped: 0 };
	try {
		cleanupStaleImageAttachmentDirs(cwd);
		const batchDir = createAttachmentBatchDir(cwd);
		const attachments: BridgedImageAttachment[] = [];
		let skipped = 0;
		for (const [index, image] of images.entries()) {
			const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : "";
			const ext = extensionForMimeType(mimeType);
			const data = typeof image.data === "string" ? normalizeBase64Data(image.data) : undefined;
			if (!ext || !data) {
				skipped++;
				continue;
			}
			const absolutePath = path.join(batchDir, `image-${index + 1}${ext}`);
			fs.writeFileSync(absolutePath, Buffer.from(data, "base64"));
			attachments.push({
				absolutePath,
				relativePath: toProjectRelativePath(cwd, absolutePath),
				mimeType,
			});
		}
		if (attachments.length === 0) removeEmptyDir(batchDir);
		return { attachments, skipped };
	} catch (error) {
		return {
			attachments: [],
			skipped: images.length,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function removeImageAttachmentBridgeState(cwd: string): void {
	fs.rmSync(getAttachmentRoot(cwd), { recursive: true, force: true });
}

function extractImageContents(event: unknown): Array<{ data?: unknown; mimeType?: unknown }> {
	const images = (event as { images?: unknown } | undefined)?.images;
	if (!Array.isArray(images)) return [];
	return images.filter((image): image is { data?: unknown; mimeType?: unknown } => Boolean(image) && typeof image === "object");
}

function createAttachmentBatchDir(cwd: string): string {
	const root = getAttachmentRoot(cwd);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = path.join(root, `${timestamp}-${crypto.randomUUID().slice(0, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function getAttachmentRoot(cwd: string): string {
	return path.join(getRunRoot(cwd), ATTACHMENT_DIR);
}

function extensionForMimeType(mimeType: string): string | undefined {
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			return ".jpg";
		case "image/png":
			return ".png";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		default:
			return undefined;
	}
}

function normalizeBase64Data(data: string): string | undefined {
	const trimmed = data.trim();
	if (!trimmed) return undefined;
	const dataUrlMatch = /^data:[^;]+;base64,(.+)$/i.exec(trimmed);
	return dataUrlMatch ? dataUrlMatch[1] : trimmed;
}

function toProjectRelativePath(cwd: string, filePath: string): string {
	return path.relative(cwd, filePath).split(path.sep).join("/");
}

function cleanupStaleImageAttachmentDirs(cwd: string, now = Date.now()): void {
	const root = getAttachmentRoot(cwd);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const fullPath = path.join(root, entry.name);
		try {
			if (now - fs.statSync(fullPath).mtimeMs > ATTACHMENT_MAX_AGE_MS) {
				fs.rmSync(fullPath, { recursive: true, force: true });
			}
		} catch {
			// Best-effort cleanup only.
		}
	}
	removeEmptyDir(root);
}

function removeEmptyDir(dir: string): void {
	try {
		fs.rmdirSync(dir);
	} catch {
		// Directory is absent or non-empty.
	}
}
