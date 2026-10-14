import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DCP_CONFIG } from "../dcp/defaults.js";
import { continuityHash, resolveContinuitySource } from "../dcp/continuity-reference.js";
import { readDcpJournalBranch, replayDcpJournal } from "../dcp/journal.js";
import { rehydrateToolRecordsFromMessages } from "../dcp/recovery.js";
import { createState } from "../dcp/state.js";

type Params = { entry_id?: string; cursor?: string; scope?: "active" | "all"; max_body_chars?: number };
type Cursor = { entryId: string; sessionId: string; bodyHash: string; offset: number };
const PREFIX = "dcp:";

export function isDcpContinuityRead(params: Params): boolean {
	return Boolean(params.entry_id?.startsWith(PREFIX) || params.cursor?.startsWith(PREFIX));
}

/** A bounded view into the existing session, never a second fact store. */
export async function readDcpContinuity(params: Params, context: unknown) {
	const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: `${message}\nOutcome UNKNOWN; do not repeat covered actions. Recover the original session first.` }], details: { found: false, sourceAvailable: false } });
	try {
		if (params.scope === "all") return fail("DCP continuity recovery requires scope=active; select the original branch to recover its references.");
		let cursor: Cursor | undefined;
		if (params.cursor) {
			cursor = JSON.parse(Buffer.from(params.cursor.slice(PREFIX.length), "base64url").toString("utf8"));
			if (!cursor || typeof cursor.entryId !== "string" || typeof cursor.sessionId !== "string" || typeof cursor.bodyHash !== "string" || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) return fail("Invalid DCP continuity cursor.");
		}
		const entryId = cursor?.entryId ?? params.entry_id ?? "";
		const match = /^dcp:b([1-9]\d*)$/.exec(entryId);
		if (!match) return fail("Expected entry_id=dcp:b<number>.");
		const ctx = context as ExtensionContext;
		const sessionId = ctx.sessionManager.getSessionId();
		if (cursor && cursor.sessionId !== sessionId) return fail("DCP continuity cursor belongs to another session.");
		// Reuse the full-ancestry reader with owner/fork/race validation, not the
		// lazy presentation tail returned by getBranch()/getEntries().
		const entries = await readDcpJournalBranch(ctx) as Array<{ id: string; message?: any }>;
		const state = createState();
		replayDcpJournal(entries, state);
		rehydrateToolRecordsFromMessages(entries.flatMap((entry) => entry.message ? [entry.message] : []), state);
		const block = state.compressionBlocks.find((item) => item.id === Number(match[1]));
		const references = block?.protectedFragments?.filter((item) => item.representation === "reference") ?? [];
		if (!references.length) return fail(`No continuity reference ${entryId} exists on this branch.`);
		const rawEntries = new Map<string, string[]>();
		for (const entry of entries) {
			const message = entry.message;
			const ids: string[] = message?.role === "toolResult" ? [message.toolCallId] : message?.role === "assistant" && Array.isArray(message.content)
				? message.content.filter((part: any) => part.type === "toolCall").map((part: any) => part.id) : [];
			for (const id of ids) rawEntries.set(id, [...rawEntries.get(id) ?? [], entry.id]);
		}
		const records = references.flatMap((reference) => reference.continuitySources ?? []).map((source) => {
			const fragment = resolveContinuitySource(source, state, DEFAULT_DCP_CONFIG);
			const id = source.kind === "raw" ? source.toolCallId : /^tool:(.+)$/.exec(source.origin)?.[1];
			const links = id ? rawEntries.get(id) ?? [] : [];
			return [fragment?.text ?? `Historical observation ${id ?? source.kind}; recover raw entries for details.`,
				...links.map((entry) => `Raw source: session action=read entry_id="${entry}" scope=active`)].join("\n");
		});
		const body = `Historical continuity for ${entryId}. UNKNOWN outcomes must be checked before retry. Not current verification.\n\n${records.join("\n\n")}`;
		const bodyHash = continuityHash(body);
		if (cursor && cursor.bodyHash !== bodyHash) return fail("DCP continuity cursor is stale or its source changed; restart recovery from entry_id.");
		const maximum = typeof params.max_body_chars === "number" && Number.isFinite(params.max_body_chars) ? Math.min(8_000, Math.max(100, Math.floor(params.max_body_chars))) : 2_000;
		const offset = cursor?.offset ?? 0;
		if (offset > body.length) return fail("DCP continuity cursor exceeds the source.");
		const end = Math.min(body.length, offset + maximum);
		const nextCursor = end < body.length ? PREFIX + Buffer.from(JSON.stringify({ entryId, sessionId, bodyHash, offset: end } satisfies Cursor)).toString("base64url") : undefined;
		const payload = {
			entryId, scope: "active", found: true, sourceAvailable: true, recordCount: records.length, hasMore: Boolean(nextCursor), nextCursor,
			text: body.slice(offset, end),
		};
		return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}
