import type { Entry } from "../types.js";

export type ConversationEntryStoreHost = {
	deleteConversationEntry(entryId: string): void;
};

export class ConversationEntryStore {
	private readonly items: Entry[] = [];
	readonly entryRenderVersions = new Map<string, number>();

	constructor(private readonly host: ConversationEntryStoreHost) {}

	get entries(): readonly Entry[] {
		return this.items;
	}

	findEntry(id: string): Entry | undefined {
		return this.items.find((entry) => entry.id === id);
	}

	findUserEntry(id: string): Extract<Entry, { kind: "user" }> | undefined {
		const entry = this.findEntry(id);
		return entry?.kind === "user" ? entry : undefined;
	}

	addEntry(entry: Entry): void {
		this.items.push(entry);
		this.markEntryChanged(entry, 1);
	}

	prependEntries(entries: readonly Entry[]): void {
		this.items.unshift(...entries);
		for (const entry of entries) this.markEntryChanged(entry, 1);
	}

	touchEntry(entry: Entry): void {
		this.markEntryChanged(entry, (this.entryRenderVersions.get(entry.id) ?? 0) + 1);
	}

	clear(): void {
		this.items.length = 0;
		this.entryRenderVersions.clear();
	}

	private markEntryChanged(entry: Entry, version: number): void {
		this.entryRenderVersions.set(entry.id, version);
		this.host.deleteConversationEntry(entry.id);
	}
}
