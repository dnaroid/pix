#!/usr/bin/env node
// Offline Claude protocol peer. No network/auth: the request creates a detached,
// setsid, TERM-resistant child; its private watchdog is a FAIL-SAFE, not proof.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
// Provider subprocesses intentionally do not inherit arbitrary test env.
const mode = readFileSync(join(process.env.HOME, "owned-fake-mode"), "utf8");
const token = args[0] === "leaf" ? args[1] : randomUUID();
const mark = (name, data = {}) => {
	const path = join(process.env.HOME, `provider-owned-${name}-${token}.json`);
	writeFileSync(`${path}.tmp`, JSON.stringify({ pid: process.pid, token, at: Date.now(), ...data }));
	renameSync(`${path}.tmp`, path);
};
mark("start", { args });
process.on("exit", (code) => mark("exit", { code }));
setTimeout(() => process.exit(124), Number(process.env.OWNED_FAKE_WATCHDOG_MS || 70000)).unref();
if (args[0] === "leaf") {
	process.on("SIGTERM", () => {});
	mark("leaf", {});
	setInterval(() => {}, 1000);
} else if (args.length === 1 && args[0] === "--version") {
	console.log("2.1.281 (offline fixture)");
} else if (args.join(" ") === "auth status") {
	console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }));
} else if (args.length === 1 && args[0] === "--help") {
	console.log("--print --setting-sources --settings --disable-slash-commands --permission-mode --no-chrome --prompt-suggestions --output-format --input-format --include-partial-messages --verbose --no-session-persistence --strict-mcp-config --mcp-config --tools --allowedTools --model --effort --system-prompt");
} else if (args.includes("--input-format") && args.includes("--output-format")) {
	let input = "";
	for await (const chunk of process.stdin) { input += chunk; if (input.includes("\n")) break; }
	const request = JSON.parse(input.trim());
	if (request.type !== "user" || request.message?.role !== "user") throw new Error("unexpected request");
	// Give the leaf its own marker identity; reusing the request token would
	// overwrite its start marker and hide one of the actual process actors.
	const child = spawn(process.execPath, [process.argv[1], "leaf", randomUUID()], { detached: true, stdio: "ignore" });
	child.on("error", (error) => { mark("spawn-error", { error: String(error) }); process.exit(98); });
	child.unref();
	mark("request", { args, input, mode, leafPid: child.pid, cwd: process.cwd(),
		env: Object.fromEntries(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"].map((key) => [key, process.env[key] ?? null])) });
	if (mode === "hold") {
		process.on("SIGTERM", () => {});
		setInterval(() => {}, 1000);
	} else {
		// The harness must observe the resistant leaf alive before allowing
		// natural completion to trigger the launcher's drain.
		const release = join(process.env.HOME, `provider-owned-release-${token}`);
		const deadline = Date.now() + 15000;
		while (!existsSync(release)) {
			if (Date.now() >= deadline) throw new Error("natural completion release deadline");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const emit = (record) => console.log(JSON.stringify(record));
		const failure = mode === "exit7";
		emit({ type: "system", subtype: "init", model: "offline-sonnet", tools: [], permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], apiKeySource: "none", mcp_servers: [] });
		const event = (value) => emit({ type: "stream_event", event: value });
		event({ type: "message_start", message: { id: "offline-message", model: "offline-sonnet", usage: { input_tokens: 4 } } });
		event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OFFLINE_PROVIDER_OK" } });
		event({ type: "content_block_stop", index: 0 });
		event({ type: "message_delta", delta: { stop_reason: failure ? "error" : "end_turn" }, usage: { output_tokens: 3 } });
		event({ type: "message_stop" });
		emit({ type: "result", subtype: failure ? "error_during_execution" : "success", is_error: failure,
			result: failure ? "OFFLINE_PROVIDER_ERROR" : "OFFLINE_PROVIDER_OK", usage: { input_tokens: 4, output_tokens: 3 } });
		process.exitCode = failure ? 7 : 0;
	}
} else {
	mark("unexpected", { args });
	process.exitCode = 98;
}
