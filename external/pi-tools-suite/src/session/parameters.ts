import { Type } from "typebox";
import { Check } from "typebox/value";

import { SESSION_ACTION_FIELDS, type SessionAction } from "./actions.js";

export const SESSION_LIMITS = { bodyChars: 8_000, entries: 50, matches: 50, sections: 100, errors: 20, queryChars: 500 } as const;

type HistoryParams = { scope?: "active" | "all" };
export type SessionParams =
	| { action: "name"; name?: string }
	| (HistoryParams & { action: "overview"; cursor?: string; max_sections?: number })
	| (HistoryParams & { action: "read"; cursor?: string; section_id?: string; entry_id?: string; max_entries?: number; max_body_chars?: number })
	| (HistoryParams & { action: "search"; cursor?: string; query: string; case_sensitive?: boolean; limit?: number })
	| (HistoryParams & { action: "recovery"; recent_error_limit?: number });

const properties = {
	action: { type: "string", enum: Object.keys(SESSION_ACTION_FIELDS), description: "name: get/set title; overview: map raw history; read: section/entry; search: literal query; recovery: deterministic signals after overview." },
	name: { type: "string", description: "name only: new title. Omit to read the current title." },
	scope: { type: "string", enum: ["active", "all"], description: "History actions: active branch (default) or all branches." },
	cursor: { type: "string", maxLength: 2_000, description: "overview/read/search: continuation cursor from the same action and scope." },
	max_sections: { type: "number", minimum: 1, maximum: SESSION_LIMITS.sections, description: "overview only: maximum sections." },
	section_id: { type: "string", maxLength: 200, description: "read only: section ID from overview/search. Pass section_id or entry_id, or continue with cursor." },
	entry_id: { type: "string", maxLength: 200, description: "read only: exact entry ID." },
	max_entries: { type: "number", minimum: 1, maximum: SESSION_LIMITS.entries, description: "read only: maximum entries." },
	max_body_chars: { type: "number", minimum: 100, maximum: SESSION_LIMITS.bodyChars, description: "read only: maximum characters per entry page." },
	query: { type: "string", minLength: 1, maxLength: SESSION_LIMITS.queryChars, description: "search only (required): literal substring." },
	case_sensitive: { type: "boolean", description: "search only: exact case matching; default false." },
	limit: { type: "number", minimum: 1, maximum: SESSION_LIMITS.matches, description: "search only: maximum matches." },
	recent_error_limit: { type: "number", minimum: 1, maximum: SESSION_LIMITS.errors, description: "recovery only: maximum recent errors." },
} as const;

const schema = { type: "object", properties, required: ["action"], additionalProperties: false };
// Flat object schemas work across the SDK's providers and codemode discovery.
export const SESSION_PARAMETERS = Type.Unsafe<SessionParams>(schema);

export function validateSessionParams(params: unknown): string | undefined {
	const valid: boolean = Check(schema, params);
	if (!valid) return "Invalid session parameters. Pass action: name, overview, read, search, or recovery and valid arguments.";
	const input = params as Record<string, unknown> & { action: SessionAction };
	const allowed: readonly string[] = SESSION_ACTION_FIELDS[input.action];
	const invalid = Object.keys(input).find((key) => key !== "action" && !allowed.includes(key));
	if (invalid) return `Parameter ${invalid} is not supported by session action ${input.action}.`;
	if (input.action === "search" && (typeof input.query !== "string" || !input.query.trim())) return "session action search requires a non-empty query.";
	return undefined;
}
