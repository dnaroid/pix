#!/usr/bin/env node
// Executable protocol peer, not a Claude Code shim or a model. Never launches children.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const marker = join(process.env.HOME, `fake-actor-${randomUUID()}.json`);
const actor = { pid: process.pid, nonce: marker.split("fake-actor-").at(-1), exited: false };
const record = (value) => {
	writeFileSync(`${marker}.tmp`, JSON.stringify(value));
	renameSync(`${marker}.tmp`, marker);
};
record(actor);
process.on("exit", (code) => record({ ...actor, exited: true, code }));
// Independent of Pi/provider's deadline, including while waiting for request stdin EOF.
const watchdog = setTimeout(() => process.exit(124), Number(process.env.PI_OFFLINE_FAKE_WATCHDOG_MS ?? 8000));
watchdog.unref();

const args = process.argv.slice(2);
const capture = (stdin = "") => writeFileSync(join(process.env.HOME, `fake-cli-${process.pid}.json`), JSON.stringify({
	args, stdin, cwd: process.cwd(),
	env: Object.fromEntries(["HOME", "PATH", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].map((key) => [key, process.env[key] ?? null])),
}));
if (args.length === 1 && args[0] === "--version") {
	capture();
	console.log("2.1.281 (offline fixture)");
} else if (args.join(" ") === "auth status") {
	capture();
	console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }));
} else if (args.length === 1 && args[0] === "--help") {
	capture();
	console.log([
		"--print", "--setting-sources", "--settings", "--disable-slash-commands", "--permission-mode", "--no-chrome",
		"--prompt-suggestions", "--output-format", "--input-format", "--include-partial-messages", "--verbose",
		"--no-session-persistence", "--strict-mcp-config", "--mcp-config", "--tools", "--allowedTools", "--model",
		"--effort", "--system-prompt",
	].join("\n"));
} else if (args.includes("--input-format") && args.includes("--output-format")) {
	let stdin = "";
	for await (const chunk of process.stdin) stdin += chunk;
	capture(stdin);
	const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
	emit({ type: "system", subtype: "init", model: "offline-sonnet", tools: [], permissionMode: "dontAsk",
		slash_commands: [], skills: [], plugins: [], apiKeySource: "none", mcp_servers: [] });
	const event = (value) => emit({ type: "stream_event", event: value });
	event({ type: "message_start", message: { id: "offline-message", model: "offline-sonnet", usage: { input_tokens: 4 } } });
	event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OFFLINE_PROVIDER_OK" } });
	event({ type: "content_block_stop", index: 0 });
	event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
	event({ type: "message_stop" });
	emit({ type: "result", subtype: "success", is_error: false, result: "OFFLINE_PROVIDER_OK", usage: { input_tokens: 4, output_tokens: 3 } });
	process.exitCode = readFileSync(join(process.env.HOME, "fake-exit-code"), "utf8").trim() === "7" ? 7 : 0;
} else {
	capture();
	console.error("Unexpected fake CLI invocation");
	process.exitCode = 98;
}
