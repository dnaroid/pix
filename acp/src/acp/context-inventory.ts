export const CONTEXT_INVENTORY_EVENT = "pi-tools-suite:context-inventory";

export interface ContextInventoryState {
	readonly version: 1;
	readonly reason?: "startup" | "reload" | "new" | "resume" | "fork" | "model_select";
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly tools: readonly string[];
	readonly skills: readonly string[];
	readonly agents?: readonly string[];
}

export function parseContextInventoryState(value: unknown): ContextInventoryState | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const tools = stringList(value.tools);
	const skills = stringList(value.skills);
	if (!tools || !skills) return undefined;
	const agents = value.agents === undefined ? undefined : stringList(value.agents);
	if (value.agents !== undefined && !agents) return undefined;
	const reason = contextInventoryReason(value.reason);
	if (value.reason !== undefined && !reason) return undefined;
	for (const key of ["sessionId", "sessionFile", "model", "thinking"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") return undefined;
	}
	const sessionId = text(value.sessionId);
	const sessionFile = text(value.sessionFile);
	const model = text(value.model);
	const thinking = text(value.thinking);
	return {
		version: 1,
		...(reason ? { reason } : {}),
		...(sessionId ? { sessionId } : {}),
		...(sessionFile ? { sessionFile } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		tools,
		skills,
		...(agents === undefined ? {} : { agents }),
	};
}

function contextInventoryReason(value: unknown): ContextInventoryState["reason"] | undefined {
	return value === "startup"
		|| value === "reload"
		|| value === "new"
		|| value === "resume"
		|| value === "fork"
		|| value === "model_select"
		? value
		: undefined;
}

export function formatReloadContextInventory(
	state: ContextInventoryState | undefined,
	heading = "/reload — reloaded extensions, skills, prompts, and context files",
): string {
	if (!state) return heading;
	const model = state.model
		? `${state.model}${state.thinking && state.thinking !== "off" ? `:${state.thinking}` : ""}`
		: "unavailable";
	return [
		heading,
		"",
		`Model: ${model}`,
		"",
		`Skills (in context): ${listOrNone(state.skills)}`,
		"",
		`Tools (active): ${listOrNone(state.tools)}`,
		"",
		`Agents (available): ${state.agents === undefined ? "(catalog unavailable)" : listOrNone(state.agents)}`,
	].join("\n");
}

export function withFinalSkillCommands(
	state: ContextInventoryState | undefined,
	commands: readonly { name: string; source: string }[],
): ContextInventoryState | undefined {
	if (!state) return undefined;
	const skillsReadable = state.tools.includes("read") || state.tools.includes("bash");
	const skills = skillsReadable
		? [...new Set(commands
			.filter((command) => command.source === "skill")
			.map((command) => command.name.replace(/^skill:/u, "").trim())
			.filter(Boolean))].sort((left, right) => left.localeCompare(right))
		: [];
	return { ...state, skills };
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listOrNone(values: readonly string[]): string {
	return values.length > 0 ? values.map(escapeMarkdownIdentifier).join(", ") : "(none)";
}

/**
 * Inventory identifiers are rendered by Desktop through MarkdownText. Keep
 * underscores literal so names such as `repo_architecture` cannot be parsed
 * as emphasis spanning neighbouring comma-separated identifiers.
 */
function escapeMarkdownIdentifier(value: string): string {
	return value.replace(/_/gu, "\\_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
