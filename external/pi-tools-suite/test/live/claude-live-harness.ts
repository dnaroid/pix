// Live Claude-subscription harness (opt-in, paid). Real personal Pi, real
// installed provider, real authenticated Claude CLI — but everything Pi-side
// is isolated: a private HOME/agent dir/config/session store, the provider
// loaded as the user-scope npm package, and a hard paid-launch budget
// enforced by the provider's own atomic launch slots. The only real-user
// resource touched is the Claude CLI, reached through a wrapper that
// restores the real HOME for that one process (auth stays inside the CLI;
// nothing here reads credentials).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE = process.env.PI_CLAUDE_LIVE === "1";
export const CHEAP_MODEL = "pi-claude-code-provider/haiku";
const REAL_HOME = homedir();
const SUITE = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface LiveEnv {
	work: string;
	home: string;
	agent: string;
	cwd: string;
	env: Record<string, string>;
	piCli: string;
	node: string;
	suiteIndex: string;
	claudeLaunches(): number;
	claudePids(): number[];
	dcpDebug(): Record<string, any>[];
	probe(): Record<string, any>[];
}

function which(name: string): string {
	return realpathSync(execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim());
}

/** Build an isolated live environment. `suiteConfig` becomes ~/.config/pi/pi-tools-suite.jsonc. */
export function liveEnv(options: { suiteConfig?: Record<string, unknown>; stageCap: number; aggregateDir: string; aggregateCap: number; extraEnv?: Record<string, string>; piSettings?: Record<string, unknown> }): LiveEnv {
	const work = mkdtempSync(join(tmpdir(), "pix-live-"));
	const home = join(work, "home"), agent = join(work, "agent"), cwd = join(work, "project");
	for (const dir of [home, agent, cwd, join(home, ".config", "pi"), join(work, "stage-budget"), join(home, "bin")]) mkdirSync(dir, { recursive: true });
	const installed = realpathSync(join(REAL_HOME, ".pi", "agent", "npm", "node_modules", "pi-claude-code-provider"));
	mkdirSync(join(agent, "npm", "node_modules"), { recursive: true });
	symlinkSync(installed, join(agent, "npm", "node_modules", "pi-claude-code-provider"), "dir");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({
		packages: ["npm:pi-claude-code-provider@0.5.0"], extensions: [], skills: [], prompts: [], themes: [],
		retry: { enabled: false }, enableInstallTelemetry: false, enableAnalytics: false, ...options.piSettings,
	}));
	writeFileSync(join(home, ".config", "pi", "pi-tools-suite.jsonc"), JSON.stringify(options.suiteConfig ?? {}));
	const claude = which("claude");
	const wrapper = join(home, "bin", "claude");
	const launches = join(work, "claude-launches");
	// Records each real CLI launch (pid) and restores the real HOME for it only.
	writeFileSync(wrapper, `#!/bin/sh\necho "$$ $*" >> '${launches}'\nHOME='${REAL_HOME}' exec '${claude}' "$@"\n`);
	chmodSync(wrapper, 0o755);
	const node = which("node");
	const env: Record<string, string> = {
		HOME: home, USER: process.env.USER ?? "", LOGNAME: process.env.LOGNAME ?? "", LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1",
		PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: tmpdir(),
		PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		PI_CLAUDE_CODE_PROVIDER_PATH: wrapper,
		PI_CLAUDE_CODE_PROVIDER_PAID_TEST_CHILD: "1",
		PI_CLAUDE_CODE_PROVIDER_PAID_STAGE_BUDGET_DIRECTORY: join(work, "stage-budget"),
		PI_CLAUDE_CODE_PROVIDER_PAID_STAGE_LAUNCH_CAP: String(options.stageCap),
		PI_CLAUDE_CODE_PROVIDER_PAID_AGGREGATE_BUDGET_DIRECTORY: options.aggregateDir,
		PI_CLAUDE_CODE_PROVIDER_PAID_AGGREGATE_LAUNCH_CAP: String(options.aggregateCap),
		PI_CLAUDE_CODE_PROVIDER_METRICS_LOG: join(work, "provider-metrics.jsonl"),
		LIVE_PROBE_LOG: join(work, "probe.jsonl"),
		PI_DCP_DEBUG_LOG: join(work, "dcp-debug.jsonl"),
		...options.extraEnv,
	};
	const jsonl = (file: string) => existsSync(file)
		? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
		: [];
	return {
		work, home, agent, cwd, env, node, piCli: which("pi"), suiteIndex: join(SUITE, "index.ts"),
		claudePids: () => existsSync(launches) ? readFileSync(launches, "utf8").split("\n").filter(Boolean).map((l) => Number(l.split(" ")[0])) : [],
		claudeLaunches: () => existsSync(launches) ? readFileSync(launches, "utf8").split("\n").filter((l) => l && !/ --version| --help| auth status/.test(l)).length : 0,
		dcpDebug: () => jsonl(join(work, "dcp-debug.jsonl")),
		probe: () => jsonl(join(work, "probe.jsonl")),
	};
}

export const PROBE_SOURCE = `import { appendFileSync } from "node:fs";
export default function (pi) {
	const log = (value) => appendFileSync(process.env.LIVE_PROBE_LOG, JSON.stringify({ at: Date.now(), ...value }) + "\\n");
	pi.on("before_provider_request", (event) => { log({ ev: "before", payload: event.payload }); });
	pi.on("after_provider_response", (event) => log({ ev: "after", status: event.status }));
	pi.on("message_end", (event) => { if (event.message?.role === "assistant") log({ ev: "end", stopReason: event.message.stopReason, provider: event.message.provider, model: event.message.model, errorMessage: event.message.errorMessage }); });
	pi.on("tool_execution_start", (event) => log({ ev: "tool", name: event.toolName }));
}
`;

export class LivePi {
	readonly records: Record<string, any>[] = [];
	private child: ChildProcess;
	private stderr = "";
	private closed: Promise<number | null>;
	constructor(readonly live: LiveEnv, args: string[]) {
		const probe = join(live.work, "probe.mjs");
		if (!existsSync(probe)) writeFileSync(probe, PROBE_SOURCE);
		this.child = spawn(live.node, [live.piCli, "--mode", "rpc", "--extension", live.suiteIndex, "--extension", probe,
			"--no-skills", "--no-prompt-templates", "--no-themes", ...args], { cwd: live.cwd, env: live.env, stdio: ["pipe", "pipe", "pipe"] });
		let buffer = "";
		this.child.stdout!.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
				if (line) try { this.records.push(JSON.parse(line)); } catch { /* non-JSON */ }
			}
		});
		this.child.stderr!.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-20_000); });
		this.closed = new Promise((done) => this.child.once("close", (code) => done(code)));
	}
	send(value: Record<string, unknown>): void { this.child.stdin!.write(`${JSON.stringify(value)}\n`); }
	async until(predicate: () => boolean, what: string, ms = 180_000): Promise<void> {
		const end = Date.now() + ms;
		while (!predicate()) {
			if (Date.now() > end) throw new Error(`live deadline: ${what}; stderr=${this.stderr.slice(-4000)}`);
			if (this.child.exitCode !== null) throw new Error(`Pi exited early (${this.child.exitCode}): ${what}; stderr=${this.stderr.slice(-4000)}`);
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	/** Send a prompt and wait until the agent settles; returns records produced for it. */
	async prompt(message: string, ms = 180_000): Promise<Record<string, any>[]> {
		const start = this.records.length;
		const settledBefore = this.records.filter((r) => r.type === "agent_settled").length;
		this.send({ id: `p${start}`, type: "prompt", message });
		await this.until(() => this.records.filter((r) => r.type === "agent_settled").length > settledBefore, `settle: ${message.slice(0, 60)}`, ms);
		return this.records.slice(start);
	}
	async request(type: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
		const id = `r${this.records.length}-${type}`;
		this.send({ id, type, ...extra });
		await this.until(() => this.records.some((r) => r.id === id), type, 30_000);
		return this.records.find((r) => r.id === id)!;
	}
	get diagnostics(): string { return this.stderr.slice(-4000); }
	async close(): Promise<number | null> {
		this.child.stdin!.end();
		const code = await Promise.race([this.closed, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
		if (code === null && this.child.exitCode === null) { this.child.kill("SIGKILL"); await this.closed; }
		return code;
	}
}

export function lastAssistantText(records: Record<string, any>[]): string {
	const ends = records.filter((r) => r.type === "message_end" && r.message?.role === "assistant");
	const message = ends.at(-1)?.message;
	return (message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}

export function listSessionFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true }).map(String).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
}
