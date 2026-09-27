// Live Claude-subscription smokes T4–T9 (opt-in and paid: PI_CLAUDE_LIVE=1).
// Cheapest model (haiku), isolated Pi state, hard paid-launch budget. Never
// part of the default offline suite.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { CHEAP_MODEL, LIVE, LivePi, lastAssistantText, listSessionFiles, liveEnv, type LiveEnv } from "./claude-live-harness.ts";

const live = LIVE ? test : test.skip;
const aggregateDir = mkdtempSync(join(tmpdir(), "pix-live-budget-"));
const AGGREGATE_CAP = Number(process.env.PI_CLAUDE_LIVE_CAP ?? 40);
const envs: LiveEnv[] = [];
afterAll(() => {
	if (process.env.PI_CLAUDE_LIVE_KEEP !== "1") for (const env of envs) rmSync(env.work, { recursive: true, force: true });
});
const MODEL_ARGS = ["--provider", "pi-claude-code-provider", "--model", "haiku", "--models", CHEAP_MODEL];

live("T4 parent: Pi tool round trip, normal completion, hook order, cancellation", async () => {
	const env = liveEnv({ stageCap: 3, aggregateDir, aggregateCap: AGGREGATE_CAP });
	envs.push(env);
	writeFileSync(join(env.cwd, "hello.txt"), "The verification token is PIX-T4-7QK.\n");
	const pi = new LivePi(env, ["--no-session", ...MODEL_ARGS]);
	try {
		const state = await pi.request("get_state");
		expect(state.data?.model?.provider, pi.diagnostics).toBe("pi-claude-code-provider");
		expect(state.data?.model?.id).toBe("haiku");
		const turn = await pi.prompt("Use the read tool to read hello.txt, then reply with only the verification token it contains.");
		const tools = env.probe().filter((e) => e.ev === "tool").map((e) => String(e.name).toLowerCase());
		expect(tools).toContain("read");
		expect(lastAssistantText(turn)).toContain("PIX-T4-7QK");
		const ends = env.probe().filter((e) => e.ev === "end");
		expect(ends.at(-1)?.stopReason).toBe("stop");
		expect(ends.some((e) => e.stopReason === "toolUse")).toBe(true);
		const order = env.probe().map((e) => e.ev).filter((ev) => ev === "before" || ev === "after");
		expect(order.slice(0, 2)).toEqual(["before", "after"]);
		// No Claude Code built-in tool ever ran: every executed tool is a Pi tool.
		expect(tools.every((name) => !name.startsWith("mcp__"))).toBe(true);

		// Cancellation stops the active provider request.
		const before = env.probe().length;
		const recordsBefore = pi.records.length;
		pi.send({ id: "long", type: "prompt", message: "Write the numbers from 1 to 400, one per line, with no other text." });
		await pi.until(() => pi.records.slice(recordsBefore).some((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "text_delta"),
			"streaming started");
		pi.send({ id: "abort", type: "abort" });
		await pi.until(() => env.probe().slice(before).some((e) => e.ev === "end"), "aborted message_end");
		const abortReply = pi.records.filter((r) => r.id === "abort" || r.id === "long");
		expect(env.probe().slice(before).find((e) => e.ev === "end")?.stopReason, JSON.stringify(abortReply)).toBe("aborted");
	} finally {
		expect(await pi.close()).toBe(0);
	}
	expect(env.claudeLaunches()).toBeLessThanOrEqual(3);
	// Every real CLI process (including the aborted one) is gone.
	await new Promise((r) => setTimeout(r, 1_000));
	expect(env.claudePids().filter(alive)).toEqual([]);
}, 300_000);

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

const FILLER = (tag: string) => Array.from({ length: 120 }, (_, i) => `${tag} line ${i}: ${"lorem ipsum dolor sit amet ".repeat(3)}`).join("\n");
const DCP_CONFIG = (summarizer: string[], timeoutMs: number) => ({ dcp: { enabled: true, debug: true,
	compress: { minContextPercent: "1%", maxContextPercent: "3%", nudgeFrequency: 1, iterationNudgeThreshold: 2, nudgeForce: "strong",
		autoCandidates: { enabled: true, minContextPercent: 0.01, keepRecentTurns: 1, minMessages: 4, minTokens: 500 },
		messageMode: { enabled: true, minContextPercent: 0.01, keepRecentTurns: 1 },
		autoCompress: { enabled: true, patience: 0, summarizerModel: summarizer, summarizerFallbackModels: [], timeoutMs } } } });

/** Three full-file reads, then a closing turn; returns the assistant answers. */
async function dcpSession(env: LiveEnv, extraArgs: string[] = []) {
	for (const tag of ["ALPHA", "BRAVO", "CHARLIE"]) writeFileSync(join(env.cwd, `${tag.toLowerCase()}.txt`), `${FILLER(tag)}\n${tag}-LAST-LINE\n`);
	const pi = new LivePi(env, ["--session-dir", join(env.work, "sessions"), ...MODEL_ARGS, ...extraArgs]);
	const answers: string[] = [];
	try {
		for (const tag of ["alpha", "bravo", "charlie"]) {
			answers.push(lastAssistantText(await pi.prompt(`Use the read tool to read the WHOLE file ${tag}.txt (no limit, no offset) and reply with only its last line.`)));
		}
		answers.push(lastAssistantText(await pi.prompt("Reply with only: OK")));
	} finally {
		expect(await pi.close()).toBe(0);
	}
	return answers;
}
const events = (env: LiveEnv, name: string) => env.dcpDebug().filter((e) => e.event === name);
const RAW_ALPHA = "ALPHA line 57:";

live("T5 DCP over Claude: projection, evidence promotion, compression updates state, pruned content never resent", async () => {
	const env = liveEnv({ stageCap: 16, aggregateDir, aggregateCap: AGGREGATE_CAP, suiteConfig: DCP_CONFIG([CHEAP_MODEL], 90_000) });
	envs.push(env);
	const answers = await dcpSession(env);
	expect(answers.slice(0, 3).map((a, i) => a.includes(["ALPHA", "BRAVO", "CHARLIE"][i] + "-LAST-LINE"))).toEqual([true, true, true]);
	const befores = env.probe().filter((e) => e.ev === "before");
	// Every provider request went through a completed DCP projection.
	expect(events(env, "provider_payload.message_ids").length).toBe(befores.length);
	expect(events(env, "context.result").length).toBeGreaterThanOrEqual(befores.length);
	expect(events(env, "provider_payload.blocked_stale_projection")).toEqual([]);
	// Correlated finalized successes promote fresh tool-result evidence over the real provider.
	expect(events(env, "provider_payload.tool_results_seen").some((e) => e.newlySeenToolResults > 0)).toBe(true);
	// Compression committed through the model's compress tool or the auto fallback.
	expect(events(env, "compress.success").length + events(env, "compress.auto").length).toBeGreaterThan(0);
	// The oldest raw tool output was sent before, never after the compression.
	expect(befores.some((e) => JSON.stringify(e.payload).includes(RAW_ALPHA))).toBe(true);
	expect(JSON.stringify(befores.at(-1)!.payload)).not.toContain(RAW_ALPHA);
	expect(answers.at(-1)).toContain("OK");
	await new Promise((r) => setTimeout(r, 1_000));
	expect(env.claudePids().filter(alive)).toEqual([]);
}, 600_000);

live("T6 DCP side summary routes through Claude haiku (compress tool unavailable, auto path)", async () => {
	const env = liveEnv({ stageCap: 16, aggregateDir, aggregateCap: AGGREGATE_CAP, suiteConfig: DCP_CONFIG([CHEAP_MODEL], 90_000) });
	envs.push(env);
	const answers = await dcpSession(env, ["--tools", "read"]);
	const auto = events(env, "compress.auto");
	expect(auto.length).toBeGreaterThan(0);
	expect(auto[0].summaryMode).toBe("model");
	expect(auto[0].summarizerModelRef).toBe(CHEAP_MODEL);
	expect(auto[0].summarizerAttempts?.[0]?.outcome).toBe("ok");
	const at = Date.parse(auto[0].ts);
	for (const request of env.probe().filter((e) => e.ev === "before" && e.at > at)) expect(JSON.stringify(request.payload)).not.toContain(RAW_ALPHA);
	expect(answers.at(-1)).toContain("OK");
}, 600_000);

live("T6 fallback: a timed-out Claude summary falls back to the programmatic summary safely", async () => {
	const env = liveEnv({ stageCap: 16, aggregateDir, aggregateCap: AGGREGATE_CAP, suiteConfig: DCP_CONFIG([CHEAP_MODEL], 1_500) });
	envs.push(env);
	const answers = await dcpSession(env, ["--tools", "read"]);
	const auto = events(env, "compress.auto");
	expect(auto.length).toBeGreaterThan(0);
	expect(auto[0].summaryMode).toBe("programmatic_fallback");
	expect(answers.at(-1)).toContain("OK");
	// The timed-out summary request left no Claude process behind.
	await new Promise((r) => setTimeout(r, 2_000));
	expect(env.claudePids().filter(alive)).toEqual([]);
}, 600_000);

/** Latest todo state snapshot in a session file (todo tool-result details or custom state entries; replay order). */
function lastTodoSnapshot(sessionFile: string): any {
	const entries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	return entries.flatMap((e) => (e.type === "custom" && e.customType === "pi-tools-suite:todo-state") ? [e.data]
		: (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo" && e.message.details?.tasks) ? [e.message.details] : []).at(-1);
}
function toolResultTexts(records: Record<string, any>[], tool: string): string[] {
	return records.filter((r) => r.type === "tool_execution_end" && String(r.toolName).toLowerCase() === tool)
		.map((r) => JSON.stringify(r.result ?? ""));
}

live("T7 todo/planning over Claude: lifecycle, persistence, compaction and resume replay", async () => {
	// Tiny keep-recent window so a short session is compactable.
	const env = liveEnv({ stageCap: 12, aggregateDir, aggregateCap: AGGREGATE_CAP, suiteConfig: { dcp: { enabled: true } },
		piSettings: { compaction: { enabled: false, keepRecentTokens: 50 } } });
	envs.push(env);
	const sessions = join(env.work, "sessions");
	let pi = new LivePi(env, ["--session-dir", sessions, ...MODEL_ARGS]);
	let file: string;
	try {
		// Project plan persistence (slash command, no model call).
		const persisted = await pi.request("prompt", { message: "/todos-persist on" });
		expect(persisted.success, JSON.stringify(persisted)).toBe(true);
		const turn = await pi.prompt("Use the todo tool with action batch_create to create exactly two tasks: subject 'alpha step' with status in_progress, and subject 'beta step' with status pending. Then use the todo tool to update 'alpha step' to status completed. Do not create any other task and do not touch 'beta step' again. Then reply with only: DONE");
		const todoCalls = turn.filter((r) => r.type === "tool_execution_end" && String(r.toolName).toLowerCase() === "todo");
		expect(todoCalls.length).toBeGreaterThanOrEqual(2);
		expect(todoCalls.every((r) => r.isError !== true)).toBe(true);
		expect(turn.some((r) => r.type === "agent_end")).toBe(true);
		file = listSessionFiles(sessions)[0];
		const snapshot = JSON.stringify(lastTodoSnapshot(file));
		expect(snapshot).toContain("alpha step");
		expect(snapshot).toContain("beta step");
		const tasks = lastTodoSnapshot(file).tasks as Array<{ subject: string; status: string }>;
		expect(tasks.find((t) => t.subject === "alpha step")?.status).toBe("completed");
		expect(tasks.find((t) => t.subject === "beta step")?.status).toBe("pending");
		// The persisted project plan mirrors it.
		const plan = readFileSync(join(env.cwd, ".pi", "todo-plan.json"), "utf8");
		expect(plan).toContain("beta step");
		// Compaction (summary through Claude) keeps the visible todo state.
		const compacted = await pi.request("compact");
		expect(compacted.success, JSON.stringify(compacted)).toBe(true);
		const listed = await pi.prompt("Call the todo tool with action list and reply with each task subject and its status.");
		const listText = toolResultTexts(listed, "todo").join("\n") + lastAssistantText(listed);
		expect(listText).toContain("beta step");
		expect(/beta step[\s\S]{0,80}pending|pending[\s\S]{0,80}beta step/i.test(listText)).toBe(true);
	} finally {
		expect(await pi.close()).toBe(0);
	}
	// A fresh Pi process resuming the persisted session replays the same todo state.
	pi = new LivePi(env, ["--session", file!, ...MODEL_ARGS]);
	try {
		const listed = await pi.prompt("Call the todo tool with action list and reply with each task subject and its status.");
		const listText = toolResultTexts(listed, "todo").join("\n") + lastAssistantText(listed);
		expect(/beta step[\s\S]{0,80}pending|pending[\s\S]{0,80}beta step/i.test(listText), listText.slice(0, 2000)).toBe(true);
	} finally {
		expect(await pi.close()).toBe(0);
	}
}, 600_000);

// ── T8/T9: real Claude children through the owned launch (launchd) ────────

function launchdAbsent(label: string): boolean {
	const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid!()}/${label}`], { encoding: "utf8", timeout: 10_000 });
	if (result.status === 113) return true;
	if (result.status === 0) return false;
	throw new Error(`ambiguous launchctl print ${label}: ${result.status}`);
}
function agentDirs(cwd: string): Map<string, string> {
	const root = join(cwd, ".pi", "subagents");
	const out = new Map<string, string>();
	if (!existsSync(root)) return out;
	for (const rel of readdirSync(root, { recursive: true }).map(String)) {
		if (rel.endsWith(`${sep}prompt.md`)) out.set(basename(dirname(join(root, rel))), dirname(join(root, rel)));
	}
	return out;
}
const read = (file: string) => existsSync(file) ? readFileSync(file, "utf8") : "";
async function waitFor(predicate: () => boolean, ms: number, what: string): Promise<void> {
	const end = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > end) throw new Error(`deadline: ${what}`);
		await new Promise((r) => setTimeout(r, 500));
	}
}
/** Owned-launch evidence for one agent: kernel-drained receipt and both exact UUID jobs retired. */
async function expectOwnedRetired(agentDir: string): Promise<void> {
	const runs = readdirSync(join(agentDir, "owned-launch")).filter((n) => /^[0-9a-f-]{36}$/.test(n)).map((n) => join(agentDir, "owned-launch", n));
	expect(runs.length).toBeGreaterThan(0);
	for (const run of runs) {
		const receipt = read(join(run, "drain.json"));
		expect(receipt, run).toMatch(/status=(ok|fail)/);
		expect(receipt).toMatch(/esrch=1|started=(\d+) exited=\1\b/);
		const spec = read(join(run, "spec.txt"));
		const labels = [...spec.matchAll(/^label_(?:supervisor|worker)=(.+)$/gm)].map((m) => m[1].trim());
		expect(labels.length).toBe(2);
		await waitFor(() => labels.every(launchdAbsent), 60_000, `jobs retired ${labels.join(",")}`);
	}
}

live("T8 Claude child sub-agent: completes, stop and timeout drain and retire", async () => {
	const env = liveEnv({ stageCap: 20, aggregateDir, aggregateCap: AGGREGATE_CAP, suiteConfig: { dcp: { enabled: false } } });
	envs.push(env);
	const pi = new LivePi(env, ["--no-session", ...MODEL_ARGS]);
	try {
		const spawnPrompt = (id: string, task: string, extra = "") =>
			`Call the subagents tool exactly once with action "spawn", watchSeconds 0${extra}, and tasks [{"id":"${id}","subagentType":"research","task":${JSON.stringify(task)},"model":"${CHEAP_MODEL}","tools":[]}]. Then reply with only: SPAWNED`;
		await pi.prompt(spawnPrompt("t8ok", "Reply with exactly this text and nothing else: CHILD-OK-42"));
		await waitFor(() => read(join(agentDirs(env.cwd).get("t8ok") ?? "/nonexistent", "exit_code")).trim() === "0", 240_000, "t8ok exit 0");
		const ok = agentDirs(env.cwd).get("t8ok")!;
		const args = read(join(ok, "pi_args")).split("\n");
		expect(args).toContain("--no-extensions");
		expect(args.some((a) => a.endsWith(join("pi-claude-code-provider", "extensions", "index.ts")))).toBe(true);
		expect(args.at(-1)?.endsWith("tool-guard.ts")).toBe(true);
		// The role's own restricted tool list; the provider web search never reaches a child.
		expect(args[args.indexOf("--tools") + 1]).not.toContain("web_search");
		expect(read(join(ok, "result.md"))).toContain("CHILD-OK-42");
		expect(read(join(ok, "progress.jsonl"))).toContain('"stage":"completed"');
		await expectOwnedRetired(ok);

		// Stop: a long child is cancelled through the durable owned path.
		await pi.prompt(spawnPrompt("t8stop", "Write the numbers from 1 to 3000, one per line, with no other text."));
		const stopDir = () => agentDirs(env.cwd).get("t8stop") ?? "/nonexistent";
		await waitFor(() => read(join(stopDir(), "progress.jsonl")).includes('"prompt_sent"'), 120_000, "t8stop prompt sent");
		await pi.prompt(`Call the subagents tool exactly once with action "stop" and agentIds ["t8stop"]. Then reply with only: STOPPED`);
		await waitFor(() => existsSync(join(stopDir(), "exit_code")), 180_000, "t8stop terminal");
		expect(read(join(stopDir(), "exit_code")).trim()).toBe("stopped");
		await expectOwnedRetired(stopDir());

		// Timeout: the child is drained and reported as 124.
		await pi.prompt(spawnPrompt("t8timeout", "Write the numbers from 1 to 5000, one per line, with no other text.", ", timeoutSeconds 20"));
		const timeoutDir = () => agentDirs(env.cwd).get("t8timeout") ?? "/nonexistent";
		await waitFor(() => existsSync(join(timeoutDir(), "exit_code")), 240_000, "t8timeout terminal");
		expect(read(join(timeoutDir(), "exit_code")).trim()).toBe("124");
		await expectOwnedRetired(timeoutDir());
	} finally {
		await pi.close();
	}
	await new Promise((r) => setTimeout(r, 2_000));
	expect(env.claudePids().filter(alive)).toEqual([]);
}, 900_000);

live("T9 concurrent Claude children obey maxConcurrent and stay within the launch budget", async () => {
	const env = liveEnv({ stageCap: 14, aggregateDir, aggregateCap: AGGREGATE_CAP, suiteConfig: { dcp: { enabled: false } },
		extraEnv: { PI_SUBAGENTS_MAX_CONCURRENT: "2" } });
	envs.push(env);
	const pi = new LivePi(env, ["--no-session", ...MODEL_ARGS]);
	const ids = ["c1", "c2", "c3"];
	try {
		const tasks = ids.map((id) => ({ id, subagentType: "research", task: `Write the numbers from 1 to 150, one per line, then the line ${id.toUpperCase()}-DONE.`, model: CHEAP_MODEL, tools: [] }));
		await pi.prompt(`Call the subagents tool exactly once with action "spawn", watchSeconds 0, and tasks ${JSON.stringify(tasks)}. Then reply with only: SPAWNED`);
		await waitFor(() => ids.every((id) => existsSync(join(agentDirs(env.cwd).get(id) ?? "/nonexistent", "exit_code"))), 480_000, "all children terminal");
	} finally {
		await pi.close();
	}
	const dirs = ids.map((id) => agentDirs(env.cwd).get(id)!);
	for (const [i, dir] of dirs.entries()) {
		expect(read(join(dir, "exit_code")).trim()).toBe("0");
		expect(read(join(dir, "result.md"))).toContain(`${ids[i].toUpperCase()}-DONE`);
		await expectOwnedRetired(dir);
	}
	// Never more than two children alive at once: [started_at, finished_at] intervals.
	const spans = dirs.map((dir) => [Date.parse(read(join(dir, "started_at")).trim()), Date.parse(read(join(dir, "finished_at")).trim())]);
	for (const [start] of spans) expect(spans.filter(([s, f]) => s <= start && start < f).length).toBeLessThanOrEqual(2);
	// No runaway retries: each child ran once; total real CLI launches stay within the stage budget.
	for (const dir of dirs) expect(read(join(dir, "retry_count")).trim() || "0").toBe("0");
	expect(env.claudeLaunches()).toBeLessThanOrEqual(14);
}, 900_000);
