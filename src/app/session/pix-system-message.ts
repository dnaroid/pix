import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../guards.js";
import type { LazySessionHistoryReader } from "./lazy-session-manager.js";

export const PIX_SYSTEM_MESSAGE_CUSTOM_TYPE = "pix-system";
export const PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE = "pix:system_message";
export const PIX_SESSION_ENTRY_ID_FIELD = "__pixSessionEntryId";

export function appendPixSystemDisplayEntry(session: AgentSession, text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	session.sessionManager.appendCustomEntry(PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE, { text: trimmed });
}

export function sessionHistoryDisplayMessages(session: AgentSession): readonly unknown[] {
	const branch = session.sessionManager.getBranch();
	if (branch.length === 0) return session.messages;
	return sessionHistoryDisplayMessagesFromEntries(branch);
}

export type SessionHistoryOlderMessagesReader = {
	hasOlder(): boolean;
	readOlder(limit: number): Promise<readonly unknown[]>;
};

export function sessionHistoryOlderMessagesReader(session: AgentSession): SessionHistoryOlderMessagesReader | undefined {
	const reader = (session.sessionManager as unknown as { createHistoryReader?: () => LazySessionHistoryReader | undefined }).createHistoryReader?.();
	if (!reader) return undefined;

	return {
		hasOlder: () => reader.hasOlder(),
		readOlder: async (limit) => sessionHistoryDisplayMessagesFromEntries(await reader.readOlder(limit)),
	};
}

export function sessionHistoryDisplayMessagesFromEntries(branch: readonly SessionEntry[]): readonly unknown[] {
	const messages: unknown[] = [];
	for (const entry of branch) {
		if (entry.type === "message") {
			messages.push(withSessionEntryId(entry.message, entry.id));
		} else if (entry.type === "custom_message") {
			messages.push({
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
			});
		} else if (isPixSystemDisplayEntry(entry)) {
			messages.push({
				role: "custom",
				customType: PIX_SYSTEM_MESSAGE_CUSTOM_TYPE,
				content: entry.data.text,
				display: true,
			});
		}
	}

	return messages;
}

export type FullBranchSessionEntryReader = {
	readFullBranchEntries(): Promise<readonly SessionEntry[]>;
};

export async function sessionHistoryFullBranchEntries(session: AgentSession): Promise<readonly SessionEntry[]> {
	const reader = session.sessionManager as unknown as Partial<FullBranchSessionEntryReader>;
	return await reader.readFullBranchEntries?.() ?? session.sessionManager.getBranch();
}

function withSessionEntryId(message: unknown, entryId: string): unknown {
	return isRecord(message) ? { ...message, [PIX_SESSION_ENTRY_ID_FIELD]: entryId } : message;
}

function isPixSystemDisplayEntry(entry: { type: string; customType?: string; data?: unknown }): entry is { type: "custom"; customType: typeof PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE; data: { text: string } } {
	return entry.type === "custom"
		&& entry.customType === PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE
		&& isRecord(entry.data)
		&& typeof entry.data.text === "string"
		&& entry.data.text.trim().length > 0;
}
