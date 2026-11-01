import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import registerBackgroundShell from "../src/background-shell/index.js";
import { registerBackgroundShellTools, setBackgroundShellManager } from "../src/background-shell/service.js";
import registerModelTools from "../src/model-tools/index.js";

class FakePi {
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	handlers = new Map<string, any[]>();
	activeTools: string[] = ["read", "bash", "custom"];
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	on(name: string, handler: any) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
	async emit(name: string, ctx: any, event: any = {}) {
		const results = [];
		for (const handler of this.handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}
	getActiveTools() { return this.activeTools; }
	setActiveTools(tools: string[]) { this.activeTools = tools; }
}

const roots: string[] = [];
// The /shell-workdir policy reads the user config (~/.config/pi/pi-tools-suite.jsonc) and an env
// override; isolate both so a developer's "restrictShellWorkdir": false cannot change the outcome.
const savedEnv = { HOME: process.env.HOME, PI_TOOLS_SUITE_RESTRICT_SHELL_WORKDIR: process.env.PI_TOOLS_SUITE_RESTRICT_SHELL_WORKDIR };
afterEach(() => {
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	setBackgroundShellManager(undefined);
	registerBackgroundShellTools(undefined);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(sessionId = "sess-1") {
	const root = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "bg-tools-")));
	roots.push(root);
	process.env.HOME = path.join(root, "home");
	delete process.env.PI_TOOLS_SUITE_RESTRICT_SHELL_WORKDIR;
	const workspace = path.join(root, "workspace");
	const outside = path.join(root, "outside");
	fs.mkdirSync(workspace);
	fs.mkdirSync(outside);
	setBackgroundShellManager(undefined);
	const pi = new FakePi();
	registerBackgroundShell(pi as any);
	registerModelTools(pi as any);
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => undefined };
	const ctx: any = {
		cwd: workspace, sessionManager, model: { provider: "anthropic", id: "claude-sonnet" }, mode: "tui",
		isIdle: () => true,
		ui: { notify: (message: string) => notices.push(message), setStatus: (_key: string, text?: string) => statuses.push(text) },
	};
	await pi.emit("session_start", ctx);
	return { pi, ctx, workspace, outside, notices, statuses };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe.if(process.platform !== "win32").serial("background shell tools", () => {
	test.serial("Bash run_in_background → BashOutput cursor → exit notice injected at turn_end", async () => {
		const { pi, ctx } = await fixture();
		expect(pi.activeTools).toEqual(["custom", "Read", "Edit", "Write", "Bash", "Grep", "Glob", "BashOutput", "KillShell"]);
		await pi.emit("agent_start", ctx);
		const started = await pi.tools.get("Bash").execute("c1", { command: "echo hello; sleep 2; echo bye; exit 2", run_in_background: true }, undefined, undefined, ctx);
		const job = started.details.backgroundJob;
		expect(job.id).toMatch(/^bg_/);
		expect(started.content[0].text).toContain("hello");
		expect(job.logPath).toContain(path.join(".pi", "artifacts", "background-shell", "sess-1"));
		await waitFor(async () => (await pi.tools.get("shell_output").execute("c", {}, undefined, undefined, ctx)).content[0].text.includes("exited(2)"));
		const [finalTurn] = await pi.emit("turn_end", ctx, { toolResults: [] });
		expect(finalTurn).toBeUndefined();
		const [turnEnd] = await pi.emit("turn_end", ctx, { toolResults: [{ role: "toolResult" }] });
		expect(turnEnd.entries[0]).toMatchObject({ type: "custom_message", customType: "background-shell-exit" });
		expect(turnEnd.entries[0].content).toContain("exited(2)");
		expect(turnEnd.continue).toBeUndefined();
		const output = await pi.tools.get("BashOutput").execute("c2", { bash_id: job.id }, undefined, undefined, ctx);
		expect(output.content[0].text).toContain("bye");
		expect(output.content[0].text).not.toContain("hello");
		const listed = await pi.tools.get("BashOutput").execute("c3", {}, undefined, undefined, ctx);
		expect(listed.content[0].text).toContain(job.id);
		expect(listed.details.jobs.map((entry: { id: string }) => entry.id)).toEqual([job.id]);
		expect(pi.tools.has("shell_jobs")).toBe(false);
	});

	test.serial("exit during the final turn never trails the transcript; it is deferred to the next prompt", async () => {
		const { pi, ctx, notices } = await fixture();
		await pi.emit("agent_start", ctx);
		const started = await pi.tools.get("Bash").execute("c1", { command: "echo done", run_in_background: true }, undefined, undefined, ctx);
		const id = started.details.backgroundJob.id;
		await waitFor(async () => (await pi.tools.get("shell_output").execute("c", {}, undefined, undefined, ctx)).content[0].text.includes("exited(0)"));
		expect(await pi.emit("turn_end", ctx, { toolResults: [] })).toEqual([undefined]);
		expect(await pi.emit("agent_before_settle", ctx)).toEqual([]);
		await pi.emit("agent_settled", ctx, { aborted: false });
		expect(notices.some((notice) => notice.includes(id))).toBe(true);
		const [next] = await pi.emit("before_agent_start", ctx);
		expect(next.message).toMatchObject({ customType: "background-shell-exit" });
		expect(next.message.content).toContain(id);
		expect(await pi.emit("before_agent_start", ctx)).toEqual([undefined]);
	});

	test.serial("idle exit only notifies UI; shell_kill stops job silently", async () => {
		const { pi, ctx, notices } = await fixture();
		const quick = await pi.tools.get("Bash").execute("c1", { command: "exit 0", run_in_background: true }, undefined, undefined, ctx);
		await waitFor(() => notices.some((notice) => notice.includes(quick.details.backgroundJob.id)));
		expect(await pi.emit("agent_before_settle", ctx)).toEqual([]);
		const long = await pi.tools.get("bash").execute("c2", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
		const before = notices.length;
		const killed = await pi.tools.get("KillShell").execute("c3", { shell_id: long.details.backgroundJob.id }, undefined, undefined, ctx);
		expect(killed.details.backgroundJob.status).toBe("killed");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(notices.length).toBe(before);
	});

	test.serial("shell run_in_background applies the /shell-workdir policy", async () => {
		const { pi, ctx, outside, workspace } = await fixture();
		await expect(pi.tools.get("shell").execute("c1", { command: "pwd", workdir: outside, run_in_background: true }, undefined, undefined, ctx))
			.rejects.toThrow("Working directory escapes workspace");
		await pi.commands.get("shell-workdir").handler(`allow ${outside}`, ctx);
		const started = await pi.tools.get("shell").execute("c2", { command: "pwd", workdir: outside, run_in_background: true }, undefined, undefined, ctx);
		expect(started.details.backgroundJob.cwd).toBe(outside);
		expect(started.details.backgroundJob.logPath.startsWith(workspace)).toBe(true);
	});

	test.serial("network bind warning and session_shutdown kills jobs", async () => {
		const { pi, ctx } = await fixture();
		const started = await pi.tools.get("Bash").execute("c1", { command: "sleep 30 # --host 0.0.0.0", run_in_background: true }, undefined, undefined, ctx);
		expect(started.content[0].text).toContain("all network interfaces");
		expect(started.details.networkWarning).toBe(true);
		const pid = started.details.backgroundJob.pid;
		await pi.emit("session_shutdown", ctx, { reason: "quit" });
		expect(() => process.kill(pid, 0)).toThrow();
		await expect(pi.tools.get("shell_output").execute("c2", { job_id: started.details.backgroundJob.id }, undefined, undefined, ctx))
			.rejects.toThrow("Unknown background job");
		await expect(pi.tools.get("Bash").execute("c3", { command: "true", run_in_background: true }, undefined, undefined, ctx))
			.rejects.toThrow("shutting down");
	});
});
