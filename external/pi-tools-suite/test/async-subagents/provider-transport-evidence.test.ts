// G3: real serializer and completion-evidence boundary of the local provider
// module (default: the vendored patched copy; opt-in external snapshot for the
// unmodified release via PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT). No account,
// no inference: the provider's own context serializer runs in-process on
// DCP-shaped logical payloads, and a real Pi RPC process drives the provider
// against the offline protocol peer to observe hook order and final stop
// reasons, which are then replayed through DCP's evidence tracker.
import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	collectProviderToolResultEvidence,
	providerPayloadIncludesReminder,
	providerPayloadIncludesToolResult,
	providerPayloadRevision,
	ProviderEvidenceTracker,
} from "../../src/dcp/provider-tool-results.ts";
import { providerSnapshotSource, stageSnapshot } from "./provider-offline-harness.ts";
import { localNode, stopAndConfirm } from "./provider-offline-rpc.ts";

const source = providerSnapshotSource();
const offline = source === undefined ? test.skip : test;
const suite = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(resolve(suite, "../.."), "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const fakeCli = fileURLToPath(new URL("./fixtures/provider-offline-cli.mjs", import.meta.url));

const works: string[] = [];
afterAll(() => { for (const work of works.splice(0)) rmSync(work, { recursive: true, force: true }); });
function stage(): { work: string; extension: string; provider: string } {
	const work = mkdtempSync(join(tmpdir(), "pi-provider-g3-"));
	works.push(work);
	const extension = stageSnapshot(source!.snapshot, work, source!.pinned);
	return { work, extension, provider: join(work, "provider") };
}

// ── In-process serializer ──────────────────────────────────────────────────

const REMINDER = "<dcp-reminder>compress stale tool output before continuing</dcp-reminder>";
const PRUNED_SECRET = "PRUNED_RAW_OUTPUT_MUST_NOT_BE_SENT";
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
const assistantCall = (id: string, path: string) => ({
	role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
	api: "pi-claude-code-provider", provider: "pi-claude-code-provider", model: "sonnet", stopReason: "toolUse", timestamp: 1,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const toolResult = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 2 });
/** A DCP-style provider projection: the pruned result's content is replaced by a placeholder, IDs stay. */
const history = () => [
	{ role: "user", content: [{ type: "text", text: "inspect the files" }], timestamp: 0 },
	assistantCall("toolu_pruned_1", "a.txt"),
	toolResult("toolu_pruned_1", "[DCP: output pruned; id toolu_pruned_1]"),
	assistantCall("toolu_fresh_2", "b.txt"),
	toolResult("toolu_fresh_2", `fresh contents of b\n${REMINDER}`),
];

async function serialize(provider: string, messages: unknown[]) {
	const serializer = await import(pathToFileURL(join(provider, "src/context-serializer.ts")).href);
	const prepared = await serializer.prepareRequestWithLimits({ systemPrompt: "system", messages, tools }, {}, join(dirname(provider), "tmp"));
	try {
		const files = readdirSync(prepared.directory).map((name) => readFileSync(join(prepared.directory, name), "utf8"));
		return { blocks: prepared.transcriptBlocks as string[], files, toolNames: prepared.toolNames as Map<string, string> };
	} finally {
		rmSync(prepared.directory, { recursive: true, force: true });
	}
}

offline("real serializer preserves tool IDs, results and reminders and never sends pruned content", async () => {
	const { provider, work } = stage();
	mkdirSync(join(work, "tmp"));
	const projected = history();
	const { blocks, files } = await serialize(provider, projected);
	const records = blocks.map((block) => JSON.parse(block));
	expect(records[0].protocol).toBe("pi-claude-code-provider-context-v4");
	const calls = records.flatMap((record) => record.role === "assistant" ? record.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id) : []);
	const results = records.filter((record) => record.role === "toolResult").map((record) => record.toolCallId);
	expect(calls).toEqual(["toolu_pruned_1", "toolu_fresh_2"]);
	expect(results).toEqual(["toolu_pruned_1", "toolu_fresh_2"]);
	const transcript = blocks.join("\n");
	expect(transcript).toContain(JSON.stringify(REMINDER).slice(1, -1));
	expect(transcript).toContain("fresh contents of b");
	for (const text of [transcript, ...files]) expect(text).not.toContain(PRUNED_SECRET);

	// DCP's evidence claims exactly what the serializer transmits.
	const logical = { systemPrompt: "system", messages: projected, tools };
	const evidence = collectProviderToolResultEvidence(logical);
	expect([...evidence.ids].sort()).toEqual([...results].sort());
	for (const id of results) {
		expect(providerPayloadIncludesToolResult(evidence, { toolCallId: id, toolName: "read", args: {}, output: "" } as any)).toBe(true);
	}
	expect(providerPayloadIncludesReminder(logical, REMINDER)).toBe(true);
	expect(providerPayloadRevision(logical)).toBeString();

	// The raw (unpruned) history would have carried the secret: the removal is the projection's, not luck.
	const raw = history();
	(raw[2] as any).content = [{ type: "text", text: PRUNED_SECRET }];
	expect((await serialize(provider, raw)).blocks.join("\n")).toContain(PRUNED_SECRET);
});

offline("real serializer keeps a stable prefix for unchanged history", async () => {
	const { provider, work } = stage();
	mkdirSync(join(work, "tmp"));
	const before = await serialize(provider, history());
	const extended = [...history(), { role: "assistant", content: [{ type: "text", text: "done" }], api: "pi-claude-code-provider",
		provider: "pi-claude-code-provider", model: "sonnet", stopReason: "stop", timestamp: 3,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		{ role: "user", content: [{ type: "text", text: "next" }], timestamp: 4 }];
	const after = await serialize(provider, extended);
	expect(after.blocks.slice(0, before.blocks.length)).toEqual(before.blocks);
	expect(after.blocks.length).toBe(before.blocks.length + 2);
	// Replacing one old result changes exactly that record, nothing before it.
	const changed = history();
	(changed[4] as any).content = [{ type: "text", text: "[DCP: output pruned; id toolu_fresh_2]" }];
	const pruned = await serialize(provider, changed);
	expect(pruned.blocks.slice(0, 5)).toEqual(before.blocks.slice(0, 5));
	expect(pruned.blocks[5]).not.toBe(before.blocks[5]);
});

// ── Real Pi RPC: hook order and final stop reasons ────────────────────────

type Line = Record<string, any>;
const PROBE = `import { appendFileSync } from "node:fs";
export default function (pi) {
	const log = (value) => appendFileSync(process.env.G3_PROBE_LOG, JSON.stringify({ at: process.hrtime.bigint().toString(), ...value }) + "\\n");
	pi.on("before_provider_request", (event) => {
		log({ ev: "before", payload: event.payload });
		if (!process.env.G3_REPLACE) return undefined;
		const messages = event.payload.messages.map((message) => message.role !== "user" ? message : ({ ...message,
			content: typeof message.content === "string" ? message.content.replaceAll(process.env.G3_REPLACE, "[projected]")
				: message.content.map((block) => block.type === "text" ? { ...block, text: block.text.replaceAll(process.env.G3_REPLACE, "[projected]") } : block) }));
		return { ...event.payload, messages };
	});
	pi.on("after_provider_response", (event) => log({ ev: "after", status: event.status }));
	pi.on("message_update", (event) => { if (event.message?.role === "assistant") log({ ev: "update" }); });
	pi.on("message_end", (event) => { if (event.message?.role === "assistant") log({ ev: "end", stopReason: event.message.stopReason, provider: event.message.provider, model: event.message.model, errorMessage: event.message.errorMessage }); });
}
`;

async function drive(mode: "success" | "error" | "truncated" | "hang", prompt: string, replace?: string) {
	const { work, extension } = stage();
	const home = join(work, "home"), agent = join(work, "agent"), cwd = join(work, "cwd");
	for (const dir of [home, agent, cwd]) mkdirSync(dir);
	writeFileSync(join(home, "fake-exit-code"), "0");
	writeFileSync(join(home, "fake-mode"), mode);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enableInstallTelemetry: false, enableAnalytics: false, extensions: [], packages: [], skills: [], prompts: [], themes: [], defaultTools: [] }));
	const probe = join(work, "probe.mjs");
	writeFileSync(probe, PROBE);
	const probeLog = join(work, "probe.jsonl");
	const node = localNode();
	const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(work, "sessions"),
		PI_CLAUDE_CODE_PROVIDER_PATH: fakeCli, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: work, LANG: "C", NO_COLOR: "1", G3_PROBE_LOG: probeLog,
		...(replace ? { G3_REPLACE: replace } : {}) };
	const child: ChildProcess = spawn(node, [cli, "--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-extensions",
		"--extension", extension, "--extension", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
		"--no-tools", "--provider", "pi-claude-code-provider", "--model", "sonnet", "--models", "pi-claude-code-provider/sonnet"],
	{ cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const closed = new Promise<void>((done) => child.once("close", () => done()));
	const records: Line[] = [];
	let stderr = "";
	let buffer = "";
	child.stdout!.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let end: number;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
			if (line) try { records.push(JSON.parse(line)); } catch { /* ignored */ }
		}
	});
	child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
	const send = (value: Line) => child.stdin!.write(`${JSON.stringify(value)}\n`);
	const probeEvents = (): Line[] => { try { return readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
	const until = async (predicate: () => boolean, what: string, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!predicate()) {
			if (Date.now() > end) throw new Error(`G3 deadline: ${what}; stderr=${stderr}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	try {
		send({ id: "prompt", type: "prompt", message: prompt });
		if (mode === "hang") {
			await until(() => probeEvents().some((e) => e.ev === "update"), "streamed content before abort");
			send({ id: "abort", type: "abort" });
		}
		await until(() => records.some((r) => r.type === "agent_settled"), "agent_settled");
		child.stdin!.end();
		await until(() => child.exitCode !== null || child.signalCode !== null, "Pi exit");
	} finally {
		await stopAndConfirm(child, closed, home, 12_000, 4);
	}
	const request = readdirSync(home).filter((n) => n.startsWith("fake-cli-")).map((n) => JSON.parse(readFileSync(join(home, n), "utf8")))
		.find((call) => call.args.includes("--input-format"));
	return { events: probeEvents(), stdin: String(request?.stdin ?? "") };
}

/** Replay the observed provider lifecycle through DCP's real tracker, exactly as dcp/index.ts wires it. */
function replay(events: Line[], ctxModel = { provider: "pi-claude-code-provider", id: "sonnet" }) {
	const tracker = new ProviderEvidenceTracker();
	const outcomes: string[] = [];
	for (const event of events) {
		if (event.ev === "before") tracker.begin({ sessionEpoch: 1, provider: ctxModel.provider, model: ctxModel.id,
			contentRevision: providerPayloadRevision(event.payload), toolIds: new Set(["toolu_x"]) });
		if (event.ev === "end") {
			const completion = tracker.complete({ sessionEpoch: 1, provider: event.provider, model: event.model, stopReason: event.stopReason });
			outcomes.push(completion.status === "promote" ? "promote" : completion.reason);
		}
	}
	return outcomes;
}

offline("provider applies the before_provider_request replacement to the outgoing CLI transcript", async () => {
	const secret = "RAW_SECRET_REMOVED_BY_PROJECTION";
	const { events, stdin } = await drive("success", `please answer ${secret}`, secret);
	expect(events.find((e) => e.ev === "before")?.payload?.messages?.at(-1)?.content).toBeDefined();
	expect(stdin).toContain("[projected]");
	expect(stdin).not.toContain(secret);
}, 60_000);

offline("validated-init response precedes content; only a finalized success is promotable", async () => {
	const { events } = await drive("success", "offline evidence probe");
	const order = events.map((e) => e.ev).filter((ev, i, all) => ev !== "update" || all[i - 1] !== "update");
	expect(order.slice(0, 3)).toEqual(["before", "after", "update"]);
	expect(events.find((e) => e.ev === "after")?.status).toBe(200);
	const end = events.find((e) => e.ev === "end")!;
	expect(end.stopReason).toBe("stop");
	// The synthetic 200 alone never promotes: promotion happens only at message_end.
	expect(replay(events.filter((e) => e.ev !== "end"))).toEqual([]);
	expect(replay(events)).toEqual(["promote"]);
}, 60_000);

for (const mode of ["error", "truncated", "hang"] as const) {
	offline(`${mode} response is never promoted even after the synthetic 200`, async () => {
		const { events } = await drive(mode, `offline ${mode} probe`);
		expect(events.some((e) => e.ev === "after" && e.status === 200)).toBe(true);
		const end = events.filter((e) => e.ev === "end");
		expect(end.length).toBe(1);
		expect(end[0].stopReason).toBe(mode === "hang" ? "aborted" : "error");
		expect(replay(events)).toEqual(["terminal-failure"]);
	}, 60_000);
}
