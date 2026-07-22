import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { InputEditor, isImagePath, looksLikeFilePath, quoteFilePathForInput, readClipboardImage } from "../../input-editor.js";
import { PASTE_DUPLICATE_WINDOW_MS } from "../constants.js";
import { normalizePastedTextForDuplicateKey } from "../rendering/render-text.js";

export type InputPasteHost = {
	readonly inputEditor: InputEditor;
	readonly cwd: string;
	inputScopeKey?(): string | undefined;
	resetRequestHistoryNavigation(): void;
	render(): void;
};

const PASTE_FINGERPRINT_PREFIX_CHARS = 64 * 1024;

export class InputPasteHandler {
	private pasteBufferParts: string[] = [];
	private readonly recentPasteFingerprints = new Map<string, number>();
	private suppressImagePathPasteUntil = 0;
	private bracketedPasteScopeKey: string | undefined;

	constructor(private readonly host: InputPasteHost) {}

	handlePlainData(data: string): boolean {
		if (!this.host.inputEditor.isInBracketedPaste && this.handlePastedFilePath(data)) return true;

		if (!this.host.inputEditor.isInBracketedPaste && this.isPlainMultilinePasteChunk(data)) {
			this.schedulePastedText(data);
			return true;
		}

		return false;
	}

	beginBracketedPaste(): void {
		this.host.inputEditor.beginBracketedPaste();
		this.pasteBufferParts = [];
		this.bracketedPasteScopeKey = this.host.inputScopeKey?.();
	}

	appendBracketedPasteText(text: string): void {
		if (text) this.pasteBufferParts.push(text);
	}

	endBracketedPaste(): void {
		this.host.inputEditor.endBracketedPaste();
		const text = this.pasteBufferParts.join("");
		this.pasteBufferParts = [];
		const scopeKey = this.bracketedPasteScopeKey;
		this.bracketedPasteScopeKey = undefined;
		if (!this.scopeIsActive(scopeKey)) return;
		this.handlePasteEnd(text);
	}

	async handleClipboardImagePaste(): Promise<void> {
		const scopeKey = this.host.inputScopeKey?.();
		const image = await readClipboardImage();
		if (!image || !this.scopeIsActive(scopeKey)) return;
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
		const fingerprintPayload = normalizedPayload.length > PASTE_FINGERPRINT_PREFIX_CHARS
			? `${normalizedPayload.length}:${normalizedPayload.slice(0, PASTE_FINGERPRINT_PREFIX_CHARS)}`
			: normalizedPayload;
		const fingerprint = `${kind}:${createHash("sha256").update(fingerprintPayload).digest("hex")}`;
		const previousTimestamp = this.recentPasteFingerprints.get(fingerprint);
		if (previousTimestamp !== undefined && now - previousTimestamp <= PASTE_DUPLICATE_WINDOW_MS) return true;

		this.recentPasteFingerprints.set(fingerprint, now);
		return false;
	}

	private handlePasteEnd(text: string): void {
		if (!text) {
			void this.handleClipboardImagePaste();
			return;
		}

		if (this.handlePastedFilePath(text)) return;

		this.schedulePastedText(text);
	}

	private handlePastedFilePath(text: string): boolean {
		const filePath = this.plainPasteFilePath(text);
		if (!filePath) return false;
		if (isImagePath(filePath) && Date.now() < this.suppressImagePathPasteUntil) {
			this.host.render();
			return true;
		}
		void this.handleFilePaste(filePath, this.host.inputScopeKey?.());
		return true;
	}

	private schedulePastedText(text: string): void {
		if (this.isDuplicatePaste("text", text)) {
			this.host.render();
			return;
		}
		this.host.resetRequestHistoryNavigation();
		this.host.inputEditor.attachPastedText(text);
		this.host.render();
	}

	private async handleFilePaste(filePath: string, scopeKey = this.host.inputScopeKey?.()): Promise<void> {
		const inputPath = await this.filePathForInput(filePath);
		if (!this.scopeIsActive(scopeKey)) return;
		this.insertPastedPathText(inputPath);
		this.host.render();
	}

	private scopeIsActive(scopeKey: string | undefined): boolean {
		return !this.host.inputScopeKey || this.host.inputScopeKey() === scopeKey;
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
