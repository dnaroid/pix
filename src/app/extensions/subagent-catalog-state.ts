export const SUBAGENTS_CATALOG_STATE_EVENT = "pi-tools-suite:async-subagents:catalog";

export interface SubagentCatalogState {
	readonly version: 1;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly model?: string;
	readonly types: readonly string[];
	readonly projectTypes?: readonly string[];
}

export function parseSubagentCatalogState(value: unknown): SubagentCatalogState | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.types)) return undefined;
	if (!value.types.every((type) => typeof type === "string" && type.trim().length > 0)) return undefined;
	if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
	if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") return undefined;
	if (value.model !== undefined && typeof value.model !== "string") return undefined;
	if (value.projectTypes !== undefined && (!Array.isArray(value.projectTypes) || !value.projectTypes.every((type) => typeof type === "string"))) return undefined;
	const types = [...new Set(value.types.map((type) => type.trim()))];
	return {
		version: 1,
		...(value.sessionId ? { sessionId: value.sessionId } : {}),
		...(value.sessionFile ? { sessionFile: value.sessionFile } : {}),
		...(value.model ? { model: value.model } : {}),
		types,
		...(Array.isArray(value.projectTypes) ? { projectTypes: [...new Set(value.projectTypes.map((type: string) => type.trim()))].filter((type) => types.includes(type)) } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
