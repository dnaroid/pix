type RewindEntry = { id: string; parentId: string | null; type: string };

/** session_tree listeners may append custom metadata after SDK navigation. */
export function isMessageEditRewindPosition(manager: {
	getLeafId(): string | null;
	getEntry(id: string): RewindEntry | undefined;
}, parentId: string | null): boolean {
	let cursor = manager.getLeafId();
	const seen = new Set<string>();
	while (cursor !== parentId) {
		if (cursor === null || seen.has(cursor)) return false;
		seen.add(cursor);
		const entry = manager.getEntry(cursor);
		// Only context-neutral custom entries may extend the rewind point.
		// Messages, summaries, or another lineage must still fail closed.
		if (!entry || entry.id !== cursor || entry.type !== "custom") return false;
		cursor = entry.parentId;
	}
	return true;
}
