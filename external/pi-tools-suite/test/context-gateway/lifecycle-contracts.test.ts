import { describe, expect, test } from "bun:test";

import dcpModule from "../../src/dcp/index.js";
import { loadConfig } from "../../src/dcp/config.js";
import { createState } from "../../src/dcp/state.js";

describe("context gateway P00: compaction lifecycle separation", () => {
	test("DCP manual compression is a tool path and observes native compaction only after session_compact", async () => {
		const config = loadConfig({ homeDir: "/__context_gateway_p00_dcp__" });
		config.enabled = true;
		config.debug = false;
		const state = createState();
		const handlers = new Map<string, any[]>();
		const tools = new Map<string, any>();
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerTool(tool: any) { tools.set(tool.name, tool); },
			registerCommand() {},
			appendEntry() {},
			sendMessage() {},
		};

		await dcpModule(pi as any, { config, state });

		expect(tools.has("compress")).toBe(true);
		expect(typeof tools.get("compress")?.execute).toBe("function");
		expect(handlers.has("session_before_compact")).toBe(false);
		expect(handlers.has("session_compact")).toBe(true);

		const epochBeforeNativeCompact = state.sessionEpoch;
		for (const handler of handlers.get("session_compact") ?? []) {
			await handler({
				type: "session_compact",
				compactionEntry: {},
				fromExtension: false,
				reason: "manual",
				willRetry: false,
			}, {});
		}

		expect(state.sessionEpoch).toBe(epochBeforeNativeCompact + 1);
	});
});
