export type SubagentFileChange = {
	path: string;
	operation: "write" | "edit" | "create" | "delete" | "move" | "modify";
	previousPath?: string;
};
export type SubagentChanges = { files: SubagentFileChange[]; gaps: string[] };

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const operations = new Set(["write", "edit", "create", "delete", "move", "modify"]);

/** Read only child-attributed durable evidence, not the parent's mutations or Git diff. */
export function aggregateSubagentChanges(entries: readonly unknown[]): SubagentChanges | undefined {
	const evidence = new Map<string, { files: SubagentFileChange[]; gaps: string[]; agentId: string }>();
	for (const entry of entries) {
		if (!record(entry) || entry.type !== "custom" || entry.customType !== "pi-tools-suite:session-changes") continue;
		const data = entry.data;
		if (!record(data) || data.version !== 1 || typeof data.agentId !== "string" || !data.agentId.trim()
			|| typeof data.toolCallId !== "string" || !Array.isArray(data.files) || !Array.isArray(data.gaps)
			|| !data.gaps.every((gap) => typeof gap === "string")) continue;
		if (!data.files.every((file) => record(file) && typeof file.path === "string" && !!file.path.trim()
			&& typeof file.operation === "string" && operations.has(file.operation)
			&& (file.previousPath === undefined || typeof file.previousPath === "string"))) continue;
		const key = JSON.stringify([data.runDir ?? null, data.agentId, data.toolCallId]);
		evidence.delete(key);
		evidence.set(key, {
			files: data.files as SubagentFileChange[], gaps: data.gaps as string[], agentId: data.agentId,
		});
	}
	if (!evidence.size) return;
	const files = new Map<string, SubagentFileChange>();
	const gaps = new Set<string>();
	for (const data of evidence.values()) {
		for (const file of data.files) files.set(file.path, { ...file });
		for (const gap of data.gaps) gaps.add(`${data.agentId}: ${gap}`);
	}
	return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), gaps: [...gaps].sort() };
}
