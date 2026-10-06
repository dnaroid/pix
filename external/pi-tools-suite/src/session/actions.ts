export const SESSION_ACTION_FIELDS = {
	name: ["name"],
	overview: ["scope", "cursor", "max_sections"],
	read: ["scope", "cursor", "section_id", "entry_id", "max_entries", "max_body_chars"],
	search: ["scope", "cursor", "query", "case_sensitive", "limit"],
	recovery: ["scope", "recent_error_limit"],
} as const;

export type SessionAction = keyof typeof SESSION_ACTION_FIELDS;

export function isSessionRecoveryCall(toolName: string, input: unknown): boolean {
	if (toolName !== "session" || !input || typeof input !== "object") return false;
	const action = (input as { action?: unknown }).action;
	return action === "overview" || action === "read" || action === "search" || action === "recovery";
}
