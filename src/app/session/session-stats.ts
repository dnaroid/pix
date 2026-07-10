import type { AgentSession, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";

type FullSessionEntriesReader = {
	readFullSessionEntries?: () => Promise<readonly SessionEntry[]>;
};

type AssistantUsage = {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
};

export async function getCompleteSessionStats(session: AgentSession): Promise<SessionStats> {
	const base = session.getSessionStats();
	const manager = session.sessionManager as typeof session.sessionManager & FullSessionEntriesReader;
	if (typeof manager.readFullSessionEntries !== "function") return base;

	const entries = await manager.readFullSessionEntries();
	return aggregateSessionStats(entries, base);
}

export function aggregateSessionStats(entries: readonly SessionEntry[], base: SessionStats): SessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		totalMessages += 1;
		const message = entry.message;
		if (message.role === "user") {
			userMessages += 1;
			continue;
		}
		if (message.role === "toolResult") {
			toolResults += 1;
			continue;
		}
		if (message.role !== "assistant") continue;

		assistantMessages += 1;
		if (Array.isArray(message.content)) {
			toolCalls += message.content.filter((content) => content.type === "toolCall").length;
		}
		const usage = message.usage as AssistantUsage | undefined;
		input += finiteNumber(usage?.input);
		output += finiteNumber(usage?.output);
		cacheRead += finiteNumber(usage?.cacheRead);
		cacheWrite += finiteNumber(usage?.cacheWrite);
		cost += finiteNumber(usage?.cost?.total);
	}

	return {
		...base,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: input + output + cacheRead + cacheWrite,
		},
		cost,
	};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
