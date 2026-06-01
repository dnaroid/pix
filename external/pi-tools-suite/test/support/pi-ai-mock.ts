import { mock } from "bun:test";

type StreamEvent = Record<string, any>;

function createMockAssistantMessageEventStream() {
	const events: StreamEvent[] = [];
	const waiters: Array<() => void> = [];
	let ended = false;
	let finalMessage: unknown;

	const notify = () => {
		for (const waiter of waiters.splice(0)) waiter();
	};

	return {
		push(event: StreamEvent) {
			events.push(event);
			if (event.type === "done") finalMessage = event.message;
			if (event.type === "error") finalMessage = event.error;
			notify();
		},
		end() {
			ended = true;
			notify();
		},
		async result() {
			while (!ended) await new Promise<void>((resolve) => waiters.push(resolve));
			return finalMessage;
		},
		async *[Symbol.asyncIterator]() {
			let index = 0;
			while (!ended || index < events.length) {
				while (index < events.length) yield events[index++];
				if (!ended) await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
	};
}

export function createPiAiMock(overrides: Record<string, unknown> = {}) {
	return {
		StringEnum: (values: readonly string[], options?: any) => ({ kind: "stringEnum", values, options }),
		calculateCost: (_model: unknown, usage: any) => {
			usage.cost ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
			return usage.cost;
		},
		complete: mock(async () => ({ content: [{ type: "text", text: "{}" }] })),
		createAssistantMessageEventStream: createMockAssistantMessageEventStream,
		...overrides,
	};
}
