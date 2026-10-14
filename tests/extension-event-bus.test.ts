import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIsolatedExtensionEventBus } from "../src/app/extensions/extension-event-bus.js";
import { pixLogger } from "../src/app/logger.js";

describe("createIsolatedExtensionEventBus", () => {
	it("captures the handler project before asynchronous failure", async t => {
		let project = "/projects/first";
		let release!: () => void;
		let observed!: (scope: unknown) => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const result = new Promise<unknown>(resolve => { observed = resolve; });
		t.mock.method(pixLogger, "log", (...args: Parameters<typeof pixLogger.log>) => {
			observed(args[3]);
			return Promise.resolve();
		});
		const bus = createIsolatedExtensionEventBus(undefined, () => project);
		bus.on("test", async () => { await gate; throw new Error("failure"); });
		bus.emit("test", {});
		project = "/projects/second";
		release();
		assert.deepEqual(await result, { module: "extension-event-bus", project: "/projects/first" });
	});
	it("keeps extension listeners scoped to one runtime bus", () => {
		const firstEvents: unknown[] = [];
		const secondEvents: unknown[] = [];
		const first = createIsolatedExtensionEventBus();
		const second = createIsolatedExtensionEventBus();

		first.on("pi-tools-suite:async-subagents:live-count", (data) => firstEvents.push(data));
		second.on("pi-tools-suite:async-subagents:live-count", (data) => secondEvents.push(data));

		first.emit("pi-tools-suite:async-subagents:live-count", { count: 1 });

		assert.deepEqual(firstEvents, [{ count: 1 }]);
		assert.deepEqual(secondEvents, []);
	});

	it("forwards emitted app-level events without sharing extension listeners", () => {
		const forwarded: Array<{ channel: string; data: unknown }> = [];
		const bus = createIsolatedExtensionEventBus((channel, data) => {
			forwarded.push({ channel, data });
		});

		bus.emit("pix:terminal-bell:attention", { sessionFile: "/tmp/session.jsonl" });

		assert.deepEqual(forwarded, [{ channel: "pix:terminal-bell:attention", data: { sessionFile: "/tmp/session.jsonl" } }]);
	});
});
