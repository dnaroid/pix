/**
 * Provider-neutral removal of thinking from earlier turns.
 *
 * The boundary is the latest user message that starts a turn, meaning one not
 * directly after a tool result. A user message after a tool result is a steer or
 * injected note inside a running tool loop, and providers such as Anthropic
 * require that loop's thinking to stay. The rule depends only on the message
 * list, so an unchanged history prefix serializes identically on every request
 * of a turn and stays cacheable.
 */

type Message = { role?: unknown; content?: unknown };

export interface HistoricalThinkingPruneResult<T> {
	messages: T[];
	prunedBlocks: number;
	droppedMessages: number;
}

export function turnBoundaryIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role !== "user") continue;
		if (messages[index - 1]?.role === "toolResult") continue;
		return index;
	}
	return -1;
}

function isThinking(block: unknown): boolean {
	return !!block && typeof block === "object" && (block as { type?: unknown }).type === "thinking";
}

/**
 * Returns new message objects only where something changed; the input is not
 * mutated. Assistant messages left with no content are dropped, as every Pi
 * transport already skips empty assistant messages.
 */
export function pruneHistoricalThinking<T extends Message>(messages: readonly T[]): HistoricalThinkingPruneResult<T> {
	const boundary = turnBoundaryIndex(messages);
	let prunedBlocks = 0;
	let droppedMessages = 0;
	const output: T[] = [];
	for (const [index, message] of messages.entries()) {
		if (index >= boundary || message?.role !== "assistant" || !Array.isArray(message.content)) {
			output.push(message);
			continue;
		}
		const kept = message.content.filter((block) => !isThinking(block));
		if (kept.length === message.content.length) {
			output.push(message);
			continue;
		}
		prunedBlocks += message.content.length - kept.length;
		if (kept.length === 0) {
			droppedMessages++;
			continue;
		}
		output.push({ ...message, content: kept });
	}
	return { messages: prunedBlocks > 0 ? output : [...messages], prunedBlocks, droppedMessages };
}
