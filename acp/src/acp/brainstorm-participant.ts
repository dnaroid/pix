import { access, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PiClient, PiRpcClientOptions } from "../pi/pi-rpc-client.js";

const RESEARCH_TOOLS = "read,grep,web_search,web_fetch,repo_context,repo_inspect,repo_audit,project_search";

/** Only trusted suite-relative provider entrypoints, never the full suite. */
export async function brainstormParticipantOptions(piEntry: string, cwd: string, suiteEntry: string | undefined, model: string): Promise<PiRpcClientOptions> {
	if (!suiteEntry) throw new Error("bundled brainstorm research extension unavailable");
	const src = join(dirname(suiteEntry), "src");
	// Bundled suite entry is src/index.ts; packaged suites may expose index.ts.
	const root = basename(dirname(suiteEntry)) === "src" ? dirname(suiteEntry) : src;
	const research = join(root, "brainstorm", "research-extension.ts");
	await access(research);
	const provider = model.slice(0, model.indexOf("/"));
	const modelId = model.slice(model.indexOf("/") + 1);
	const extensions = [research];
	if (provider === "antigravity") extensions.push(join(root, "antigravity-auth", "index.ts"));
	if (provider === "pi-claude-code-provider") {
		const providerRoot = join(root, "claude-code-provider");
		const manifest = JSON.parse(await readFile(join(providerRoot, "package.json"), "utf8"));
		if (manifest.name !== provider || manifest.version !== "0.5.0") throw new Error("unsupported bundled Claude provider");
		extensions.push(join(providerRoot, "index.ts"));
	}
	for (const extension of extensions) await access(extension);
	return { piEntry, cwd, provider, model: modelId, env: {
		PIX_ACP_SESSION_STATE_BRIDGE: "1", PIX_BRAINSTORM_PARTICIPANT: "1",
		PIX_BRAINSTORM_HOST_URL: "", PIX_BRAINSTORM_HOST_TOKEN: "",
	}, args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", RESEARCH_TOOLS,
		"--models", model, ...extensions.flatMap((path) => ["--extension", path])] };
}

/** Append-only entry identity prevents a prior round's answer being reused. */
export async function freshParticipantAnswer(pi: PiClient, task: string, execute: () => Promise<{ stopReason: string }>, signal: AbortSignal): Promise<string> {
	const before = new Set((await pi.getEntries()).entries.map((entry) => entry.id));
	signal.throwIfAborted();
	const result = await execute();
	signal.throwIfAborted();
	if (result.stopReason !== "end_turn" && result.stopReason !== "max_tokens") throw new Error(`participant prompt ended with ${result.stopReason}`);
	const fresh = (await pi.getEntries()).entries.filter((entry) => !before.has(entry.id));
	signal.throwIfAborted();
	let submitted = false;
	let answer: string | undefined;
	for (const entry of fresh) {
		const message = entry.message as { role?: string; content?: unknown; stopReason?: string } | undefined;
		if (!message) continue;
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
				? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
			if (text === task) submitted = true;
		} else if (submitted && message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(`participant assistant ${message.stopReason}`);
			answer = Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : undefined;
		}
	}
	if (!submitted || !answer?.trim()) throw new Error("no fresh settled participant answer");
	if (answer.length > 40_000) throw new Error("participant response exceeds 40,000 characters");
	return answer;
}
