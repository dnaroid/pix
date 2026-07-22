import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fuzzySearch, type FuzzyMatch, type FuzzySearchItem } from "../../fuzzy.js";
import {
	REQUEST_HISTORY_MAX_BYTES,
	REQUEST_HISTORY_MAX_ENTRIES,
	REQUEST_HISTORY_MAX_ENTRY_BYTES,
	REQUEST_HISTORY_VERSION,
} from "../constants.js";
import { isRecord } from "../guards.js";

export type RequestHistoryHost = {
	readonly noSession: boolean;
	getInput(): string;
	setInput(value: string): void;
	resetInputMenuDismissals(): void;
	render(): void;
};

export type RequestHistorySearchMatch = FuzzyMatch<string>;

export class AppRequestHistory {
	private entries: string[] = [];
	private cursor: number | undefined;
	private draft = "";
	private saveChain = Promise.resolve();
	private saveSequence = 0;

	constructor(private readonly host: RequestHistoryHost) {}

	async load(): Promise<void> {
		if (this.host.noSession) return Promise.resolve();

		try {
			const raw = await readFile(this.filePath(), "utf8");
			const parsed: unknown = JSON.parse(raw);
			const entries = Array.isArray(parsed)
				? parsed
				: isRecord(parsed) && Array.isArray(parsed.entries)
					? parsed.entries
					: [];
			this.entries = this.limited(entries.filter((entry): entry is string => typeof entry === "string"));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return;
			this.entries = [];
		}
	}

	add(text: string): void {
		const normalized = text.trimEnd();
		this.resetNavigation();
		if (!normalized.trim()) return;
		if (Buffer.byteLength(normalized, "utf8") > REQUEST_HISTORY_MAX_ENTRY_BYTES) return;

		this.entries = this.limited([...this.entries, normalized]);
		void this.save();
	}

	search(query: string, limit = 50): string[] {
		return this.searchMatches(query, limit).map((match) => match.value);
	}

	searchMatches(query: string, limit = 50): RequestHistorySearchMatch[] {
		const items: FuzzySearchItem<string>[] = [...this.entries].reverse().map((entry) => ({
			value: entry,
			label: entry,
		}));
		return fuzzySearch(items, query, { limit, minScorePerCharacter: 8, preferKeyboardLayoutMatches: true });
	}

	resetNavigation(): void {
		this.cursor = undefined;
		this.draft = "";
	}

	navigate(direction: -1 | 1): boolean {
		if (this.entries.length === 0) return false;

		if (this.cursor === undefined) {
			if (direction > 0) return false;
			if (this.host.getInput().length > 0) return false;
			this.draft = this.host.getInput();
			this.cursor = this.entries.length - 1;
			const entry = this.entries[this.cursor];
			if (entry === undefined) return false;
			this.replaceInput(entry);
			return true;
		}

		const nextCursor = this.cursor + direction;
		if (nextCursor < 0) {
			const entry = this.entries[0];
			if (entry === undefined) return false;
			this.cursor = 0;
			this.replaceInput(entry);
			return true;
		}

		if (nextCursor >= this.entries.length) {
			const draft = this.draft;
			this.resetNavigation();
			this.replaceInput(draft);
			return true;
		}

		const entry = this.entries[nextCursor];
		if (entry === undefined) return false;
		this.cursor = nextCursor;
		this.replaceInput(entry);
		return true;
	}

	private save(): Promise<void> {
		if (this.host.noSession) return Promise.resolve();
		this.entries = this.limited(this.entries);
		const payload = this.payload(this.entries);
		const sequence = ++this.saveSequence;
		const writeSnapshot = async (): Promise<void> => {
			try {
				const filePath = this.filePath();
				await mkdir(dirname(filePath), { recursive: true });
				const tempPath = `${filePath}.${process.pid}.${sequence}.tmp`;
				await writeFile(tempPath, payload, "utf8");
				await rename(tempPath, filePath);
			} catch {
				// Request history is a convenience feature; never interrupt the UI on disk errors.
			}
		};

		this.saveChain = this.saveChain.then(writeSnapshot, writeSnapshot);
		return this.saveChain;
	}

	private replaceInput(value: string): void {
		if (value !== this.host.getInput()) {
			this.host.resetInputMenuDismissals();
		}
		this.host.setInput(value);
		this.host.render();
	}

	private filePath(): string {
		return join(getAgentDir(), "pix", "request-history.json");
	}

	private payload(entries: readonly string[]): string {
		return JSON.stringify({ version: REQUEST_HISTORY_VERSION, entries }, null, 2);
	}

	private limited(entries: readonly string[]): string[] {
		const unique: string[] = [];
		for (const entry of entries) {
			const normalized = entry.trimEnd();
			if (!normalized.trim()) continue;
			if (Buffer.byteLength(normalized, "utf8") > REQUEST_HISTORY_MAX_ENTRY_BYTES) continue;

			const existingIndex = unique.indexOf(normalized);
			if (existingIndex >= 0) unique.splice(existingIndex, 1);
			unique.push(normalized);
		}

		const limited = unique.slice(-REQUEST_HISTORY_MAX_ENTRIES);
		while (limited.length > 0 && Buffer.byteLength(this.payload(limited), "utf8") > REQUEST_HISTORY_MAX_BYTES) {
			limited.shift();
		}
		return limited;
	}
}
