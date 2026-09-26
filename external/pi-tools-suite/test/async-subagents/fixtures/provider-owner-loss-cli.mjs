#!/usr/bin/env node
// Offline protocol peer: a real request stays active until Pi's owner is killed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const mode = process.argv[2];
const args = process.argv.slice(2);
const token = randomUUID();
const mark = (name, value) => {
	const path = join(home, `owner-loss-${name}-${token}.json`);
	writeFileSync(`${path}.tmp`, JSON.stringify({ pid: process.pid, token, at: Date.now(), ...value }));
	renameSync(`${path}.tmp`, path);
};
mark("start", { mode });
process.on("exit", (code) => mark("exit", { mode, code }));
// Both actors have independent, short fail-safes. A watchdog exit is NOT proof
// of owner-loss cleanup; the test checks the actors before these deadlines.
const watchdog = setTimeout(() => process.exit(124), mode === "leaf" ? 14_000 : 12_000);
watchdog.unref();

if (mode === "leaf") {
	process.on("SIGTERM", () => {});
	mark("leaf-ready", {});
	setInterval(() => {}, 1000);
} else if (args.length === 1 && args[0] === "--version") {
	mark("preflight", { args });
	console.log("2.1.281 (offline fixture)");
} else if (args.join(" ") === "auth status") {
	mark("preflight", { args });
	console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }));
} else if (args.length === 1 && args[0] === "--help") {
	mark("preflight", { args });
	console.log([
		"--print", "--setting-sources", "--settings", "--disable-slash-commands", "--permission-mode", "--no-chrome",
		"--prompt-suggestions", "--output-format", "--input-format", "--include-partial-messages", "--verbose",
		"--no-session-persistence", "--strict-mcp-config", "--mcp-config", "--tools", "--allowedTools", "--model",
		"--effort", "--system-prompt",
	].join("\n"));
} else if (args.includes("--input-format") && args.includes("--output-format")) {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (input.includes("\n")) break; // Never require stdin EOF to establish an active request.
	}
	const request = JSON.parse(input.trim());
	if (request.type !== "user" || request.message?.role !== "user") throw new Error("Unexpected request protocol");
	const leaf = spawn(process.execPath, [process.argv[1], "leaf"], { stdio: "ignore" }); // Inherits B's process group.
	leaf.on("error", (error) => { mark("spawn-error", { error: String(error) }); process.exit(98); });
	mark("request-ready", { args, input, leafPid: leaf.pid, cwd: process.cwd(),
		env: Object.fromEntries(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"].map((key) => [key, process.env[key] ?? null])) });
	// No result and no exit until native ownership cleanup or independent watchdog.
	setInterval(() => {}, 1000);
} else {
	mark("unexpected", { args });
	process.exitCode = 98;
}
