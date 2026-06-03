import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getIdleRuntime, getRuntime, parsePathArgument } from "../src/app/commands/command-runtime.js";
import type { CommandControllerHost } from "../src/app/commands/command-host.js";

describe("command runtime helpers", () => {
	it("returns the runtime when it is initialized and idle", () => {
		const runtime = { session: { isStreaming: false } };
		const host = hostWithRuntime(runtime);

		assert.equal(getRuntime(host, "fork"), runtime);
		assert.equal(getIdleRuntime(host, "fork"), runtime);
		assert.deepEqual(host.events, []);
	});

	it("reports missing runtimes and running sessions", () => {
		const missing = hostWithRuntime(undefined);
		assert.equal(getRuntime(missing, "resume"), undefined);
		assert.deepEqual(missing.events, ["error:/resume unavailable", "entry:Runtime is not initialized"]);

		const running = hostWithRuntime({ session: { isStreaming: true } });
		assert.equal(getIdleRuntime(running, "model"), undefined);
		assert.deepEqual(running.events, ["warning:/model is unavailable while the agent is running"]);
	});

	it("parses unquoted and quoted path arguments", () => {
		assert.equal(parsePathArgument(""), undefined);
		assert.equal(parsePathArgument("  src/file.ts --flag"), "src/file.ts");
		assert.equal(parsePathArgument("'/path with spaces/file.ts' extra"), "/path with spaces/file.ts");
		assert.equal(parsePathArgument('"unterminated path'), "unterminated path");
	});
});

function hostWithRuntime(runtime: unknown): CommandControllerHost & { events: string[] } {
	const events: string[] = [];
	return ({
		events,
		runtime: () => runtime,
		toast: {
			error: (message: string) => events.push(`error:${message}`),
			warning: (message: string) => events.push(`warning:${message}`),
		} as unknown as CommandControllerHost["toast"],
		addEntry: (entry: { text?: string }) => events.push(`entry:${entry.text ?? ""}`),
	} as unknown) as CommandControllerHost & { events: string[] };
}
