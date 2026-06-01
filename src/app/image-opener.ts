import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ImageContent } from "../input-editor.js";

export function openImageContent(image: ImageContent): boolean {
	const filePath = writeImageTempFile(image);
	if (!filePath) return false;
	return openPathWithSystemViewer(filePath);
}

function writeImageTempFile(image: ImageContent): string | undefined {
	try {
		const data = Buffer.from(image.data, "base64");
		if (data.length === 0) return undefined;

		const dir = join(tmpdir(), "pix-image-open");
		mkdirSync(dir, { recursive: true });
		const hash = createHash("sha256").update(image.mimeType).update("\0").update(data).digest("hex").slice(0, 24);
		const filePath = join(dir, `${hash}${imageExtension(image.mimeType)}`);
		if (!existsSync(filePath)) writeFileSync(filePath, data, { flag: "wx" });
		return filePath;
	} catch {
		return undefined;
	}
}

function imageExtension(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/jpeg":
		case "image/jpg":
			return ".jpg";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "image/bmp":
			return ".bmp";
		case "image/svg+xml":
			return ".svg";
		case "image/png":
		default:
			return ".png";
	}
}

function openPathWithSystemViewer(filePath: string): boolean {
	if (process.platform === "darwin") return spawnDetached("open", [filePath]);
	if (process.platform === "win32") return spawnDetached("cmd", ["/c", "start", "", filePath]);
	return spawnDetached("xdg-open", [filePath]);
}

function spawnDetached(command: string, args: readonly string[]): boolean {
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
