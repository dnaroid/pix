import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { InputEditor, isImagePath, looksLikeFilePath, quoteFilePathForInput, readClipboardImage } from "../../input-editor.js";
import { PASTE_DUPLICATE_WINDOW_MS } from "../constants.js";
import { normalizePastedTextForDuplicateKey } from "../rendering/render-text.js";

export type InputPasteHost = {
	readonly inputEditor: InputEditor;
	readonly cwd: string;
	resetRequestHistoryNavigation(): void;
	render(): void;
};

export class InputPasteHandler {
	private pasteBuffer = "";
	private readonly recentPasteFingerprints = new Map<string, number>();
	private suppressImagePathPasteUntil = 0;

	constructor(private readonly host: InputPasteHost) {}

	handlePlainData(data: string): boolean {
		const plainFilePath = !this.host.inputEditor.isInBracketedPaste && this.plainPasteFilePath(data);
		if (plainFilePath) {
			if (isImagePath(plainFilePath) && Date.now() < this.suppressImagePathPasteUntil) {
				this.host.render();
				return true;
			}
			void this.handleFilePaste(plainFilePath);
			return true;
		}

		if (!this.host.inputEditor.isInBracketedPaste && this.isPlainMultilinePasteChunk(data)) {
			if (this.isDuplicatePaste("text", data)) {
				this.host.render();
				return true;
			}
			this.host.resetRequestHistoryNavigation();
			this.host.inputEditor.attachPastedText(data);
			this.host.render();
			return true;
		}

		return false;
	}

	beginBracketedPaste(): void {
		this.host.inputEditor.beginBracketedPaste();
		this.pasteBuffer = "";
	}

	appendBracketedPasteText(text: string): void {
		this.pasteBuffer += text;
	}

	endBracketedPaste(): void {
		this.host.inputEditor.endBracketedPaste();
		this.handlePasteEnd();
	}

	async handleClipboardImagePaste(): Promise<void> {
		const image = await readClipboardImage();
		if (!image) return;
		if (this.isDuplicatePaste(`image:${image.mimeType}`, image.data)) {
			this.host.render();
			return;
		}

		this.host.resetRequestHistoryNavigation();
		this.host.inputEditor.attachImage(image.data, image.mimeType);
		this.suppressImagePathPasteUntil = Date.now() + 1000;
		this.host.render();
	}

	private isPlainMultilinePasteChunk(data: string): boolean {
		if (data.length <= 1) return false;
		if (data.includes("\x1b")) return false;
		if (!data.includes("\n") && !data.includes("\r")) return false;
		return true;
	}

	private plainPasteFilePath(data: string): string | null {
		if (data.length <= 1) return null;
		if (data.includes("\x1b")) return null;
		if (data.includes("\n") || data.includes("\r")) return null;
		return looksLikeFilePath(data);
	}

	private isDuplicatePaste(kind: string, payload: string): boolean {
		const now = Date.now();
		for (const [fingerprint, timestamp] of this.recentPasteFingerprints) {
			if (now - timestamp > PASTE_DUPLICATE_WINDOW_MS) this.recentPasteFingerprints.delete(fingerprint);
		}

		const normalizedPayload = kind === "text" ? normalizePastedTextForDuplicateKey(payload) : payload;
		const fingerprint = `${kind}:${createHash("sha256").update(normalizedPayload).digest("hex")}`;
		const previousTimestamp = this.recentPasteFingerprints.get(fingerprint);
		if (previousTimestamp !== undefined && now - previousTimestamp <= PASTE_DUPLICATE_WINDOW_MS) return true;

		this.recentPasteFingerprints.set(fingerprint, now);
		return false;
	}

	private handlePasteEnd(): void {
		const text = this.pasteBuffer;
		this.pasteBuffer = "";
		if (!text) return;

		const filePath = this.plainPasteFilePath(text);
		if (filePath) {
			if (isImagePath(filePath) && Date.now() < this.suppressImagePathPasteUntil) {
				this.host.render();
				return;
			}
			void this.handleFilePaste(filePath);
			return;
		}

		if (this.isDuplicatePaste("text", text)) {
			this.host.render();
			return;
		}
		this.host.resetRequestHistoryNavigation();
		this.host.inputEditor.attachPastedText(text);
		this.host.render();
	}

	private async handleFilePaste(filePath: string): Promise<void> {
		const inputPath = await this.filePathForInput(filePath);
		this.insertPastedPathText(inputPath);
		this.host.render();
	}

	private async filePathForInput(filePath: string): Promise<string> {
		const resolved = resolve(this.host.cwd, filePath);
		try {
			const s = await stat(resolved);
			if (s.isFile()) return this.displayPathForInput(resolved);
		} catch {
			// The terminal can still paste a file-looking path before the file is
			// visible to us. Insert the path text instead of trying to attach content.
		}
		return this.displayPathForInput(resolved);
	}

	private displayPathForInput(resolvedPath: string): string {
		const cwd = resolve(this.host.cwd);
		const rel = relative(cwd, resolvedPath);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
		return resolvedPath;
	}

	private insertPastedPathText(filePath: string): void {
		if (this.isDuplicatePaste("text", filePath)) return;
		this.host.resetRequestHistoryNavigation();
		this.host.inputEditor.insert(quoteFilePathForInput(filePath));
	}
}
