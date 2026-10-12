import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Run in a Node subprocess so replacing a builtin/platform never leaks into
// other Bun tests. Exercise the real launcher even on non-Windows CI hosts.
const originalSpawn = childProcess.spawn;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let unreferenced = false;
try {
	Object.defineProperty(process, "platform", { value: process.argv[2] });
	childProcess.spawn = (_command, args, options) => {
		// On Windows, libuv kills a non-detached child when its parent's Job
		// Object closes. unref() alone does not remove that ownership.
		assert.equal(options.detached, true, "broker must survive its initiating CLI's exit");
		assert.deepEqual(options.stdio.slice(0, 2), ["ignore", "ignore"]);
		writeFileSync(args.at(-1), JSON.stringify({ ok: true, result: { content: [] } }));
		return { unref() { unreferenced = true; } };
	};
	syncBuiltinESMExports();
	const { launchSubagentsBroker } = await import("../../src/headless/subagent-broker.ts");
	await launchSubagentsBroker("offline-request", process.cwd(), new AbortController().signal);
	assert.equal(unreferenced, true);
} finally {
	childProcess.spawn = originalSpawn;
	Object.defineProperty(process, "platform", originalPlatform);
	syncBuiltinESMExports();
}
