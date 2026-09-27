// Provider dependency injection for isolated children (plan P2–P6, T1).
// Offline and deterministic: Pi's installed-package lookup is injected, the
// Claude path stops at the (mocked) owned-launch boundary, and non-Claude
// children are a tiny fake `pi` script.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "../../src/async-subagents/core/spawn.js";
import { selectsOwnedProvider } from "../../src/async-subagents/core/owned-launch-integration.js";
import { spawnAgentWithRetry } from "../../src/async-subagents/core/retry.js";
import { resetSessionModelFallbacks } from "../../src/async-subagents/core/model-fallback.js";
import {
	antigravityEntrypoint,
	defaultInstalledPackageLocator,
	normalizeProviderArgs,
	selectsClaudeProvider,
	ProviderExtensionError,
	resolveProviderExtensions,
} from "../../src/async-subagents/core/provider-extensions.js";
import type { OwnedLaunchBinaries } from "../../src/async-subagents/core/owned-launch/bootstrap.js";

const STUB = fileURLToPath(new URL("./fixtures/claude-provider-stub", import.meta.url));
const STUB_ENTRY = fs.realpathSync(path.join(STUB, "extensions", "index.ts"));
const FAKE_BINARIES: OwnedLaunchBinaries = { bridge: "/nonexistent/bridge", gate: "/nonexistent/gate", supervisor: "/nonexistent/supervisor" };
const CLAUDE = "pi-claude-code-provider/sonnet";

const roots: string[] = [];
const originalPlatform = process.platform;
const originalArgv1 = process.argv[1];
const originalEnvModel = process.env.ASYNC_SUBAGENTS_MODEL;
const tempDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-ext-"));
	roots.push(dir);
	return dir;
};
beforeEach(() => {
	delete process.env.ASYNC_SUBAGENTS_MODEL;
	resetSessionModelFallbacks();
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	process.argv[1] = originalArgv1;
	if (originalEnvModel === undefined) delete process.env.ASYNC_SUBAGENTS_MODEL;
	else process.env.ASYNC_SUBAGENTS_MODEL = originalEnvModel;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A package directory with an arbitrary manifest and entry file. */
function fakePackage(manifest: Record<string, unknown>, entry = "extensions/index.ts"): string {
	const root = tempDir();
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
	fs.mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
	fs.writeFileSync(path.join(root, entry), "export default function () {}\n");
	return root;
}
const claudeManifest = (overrides: Record<string, unknown> = {}) => ({
	name: "pi-claude-code-provider", version: "0.5.0", pi: { extensions: ["./extensions/index.ts"] }, ...overrides,
});
const resolveClaude = (locate: () => string[], forwardedArgs: string[] = []) =>
	resolveProviderExtensions({ selectedModel: CLAUDE, explicitModel: CLAUDE, claudeSelected: true, forwardedArgs, cwd: tempDir(), locateInstalled: locate });
const code = (fn: () => unknown) => {
	try { fn(); } catch (error) { return error instanceof ProviderExtensionError ? error.code : `other:${String(error)}`; }
	return "no-error";
};

describe("provider dependency resolver", () => {
	test("Claude resolves exactly one validated entrypoint through the installed-package lookup", () => {
		expect(resolveClaude(() => [STUB])).toEqual([STUB_ENTRY]);
		// Aliases under the same provider reuse the same entrypoint.
		const opus = resolveProviderExtensions({ selectedModel: "pi-claude-code-provider/opus", explicitModel: undefined,
			claudeSelected: true, forwardedArgs: [], cwd: tempDir(), locateInstalled: () => [STUB] });
		expect(opus).toEqual([STUB_ENTRY]);
	});

	test("ordinary providers load nothing; Antigravity only when explicitly selected", () => {
		const none = (explicitModel?: string, selectedModel?: string) => resolveProviderExtensions({
			selectedModel, explicitModel, claudeSelected: false, forwardedArgs: [], cwd: tempDir(),
			locateInstalled: () => { throw new Error("must not look up packages"); },
		});
		expect(none("zai/glm-5-turbo", "zai/glm-5-turbo")).toEqual([]);
		expect(none(undefined, "antigravity/gemini-from-env")).toEqual([]);
		expect(none("antigravity/", "antigravity/")).toEqual([]);
		expect(none("antigravity/gemini-explicit", "antigravity/gemini-explicit")).toEqual([antigravityEntrypoint()]);
	});

	test("an explicitly supplied provider extension is validated and never duplicated", () => {
		expect(resolveClaude(() => { throw new Error("must not look up packages"); }, ["--extension", STUB_ENTRY])).toEqual([]);
		const bad = fakePackage(claudeManifest({ version: "0.6.0" }));
		expect(code(() => resolveClaude(() => [], ["--extension", path.join(bad, "extensions", "index.ts")]))).toBe("provider_version_unsupported");
	});

	test("typed permanent failures: missing, unsupported version, invalid metadata", () => {
		expect(code(() => resolveClaude(() => []))).toBe("provider_not_installed");
		expect(code(() => resolveClaude(() => [fakePackage(claudeManifest({ version: "0.5.1" }))]))).toBe("provider_version_unsupported");
		expect(code(() => resolveClaude(() => [fakePackage(claudeManifest({ pi: { extensions: ["./a.ts", "./b.ts"] } }))]))).toBe("provider_metadata_invalid");
		expect(code(() => resolveClaude(() => [fakePackage(claudeManifest({ pi: { extensions: ["../../escape.ts"] } }))]))).toBe("provider_metadata_invalid");
		expect(code(() => resolveClaude(() => [fakePackage(claudeManifest({ pi: {} }))]))).toBe("provider_metadata_invalid");
		const missingEntry = fakePackage(claudeManifest({ pi: { extensions: ["./extensions/missing.ts"] } }));
		expect(code(() => resolveClaude(() => [missingEntry]))).toBe("provider_metadata_invalid");
		const error = (() => { try { resolveClaude(() => []); } catch (e) { return e as ProviderExtensionError; } })()!;
		expect(error.permanent).toBe(true);
		expect(error.message).toContain(CLAUDE);
		expect(error.message).toContain("pi install npm:pi-claude-code-provider@0.5.0");
		expect(error.message.length).toBeLessThanOrEqual(1_000);
	});

	test("unsupported CLI spellings are normalized to the child-accepted form", () => {
		expect(normalizeProviderArgs(["-m", "a/b", "--model=c/d", "--provider=p", "--thinking", "high"]))
			.toEqual(["--model", "a/b", "--model", "c/d", "--provider", "p", "--thinking", "high"]);
		expect(normalizeProviderArgs(["--models", "x/*"])).toEqual(["--models", "x/*"]);
	});
});

describe("installed-package lookup trust boundary", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});
	/** An isolated Pi agent dir whose user settings list the given package sources. */
	function agentDirWith(packages: unknown[]): string {
		const agentDir = tempDir();
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return agentDir;
	}
	/** A managed user-scope npm install of a package with this manifest. */
	function installManaged(agentDir: string, manifest: Record<string, unknown>): string {
		const root = path.join(agentDir, "npm", "node_modules", "pi-claude-code-provider");
		fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
		fs.writeFileSync(path.join(root, "extensions", "index.ts"), "export default function () {}\n");
		return root;
	}

	test("a user-scope npm install is found", () => {
		const agentDir = agentDirWith(["npm:pi-claude-code-provider@0.5.0"]);
		const root = installManaged(agentDir, claudeManifest());
		expect(defaultInstalledPackageLocator("pi-claude-code-provider", tempDir())).toEqual([root]);
		expect(resolveProviderExtensions({ selectedModel: CLAUDE, explicitModel: CLAUDE, claudeSelected: true, forwardedArgs: [], cwd: tempDir() }))
			.toEqual([fs.realpathSync(path.join(root, "extensions", "index.ts"))]);
	});

	test("an untrusted project cannot supply the provider (project settings are never read)", () => {
		agentDirWith([]);
		const repo = tempDir();
		const evil = fakePackage(claudeManifest());
		fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ packages: [evil, "npm:pi-claude-code-provider@0.5.0"] }));
		fs.mkdirSync(path.join(repo, ".pi", "npm", "node_modules"), { recursive: true });
		fs.symlinkSync(evil, path.join(repo, ".pi", "npm", "node_modules", "pi-claude-code-provider"));
		expect(defaultInstalledPackageLocator("pi-claude-code-provider", repo)).toEqual([]);
		expect(code(() => resolveProviderExtensions({ selectedModel: CLAUDE, explicitModel: CLAUDE, claudeSelected: true, forwardedArgs: [], cwd: repo })))
			.toBe("provider_not_installed");
	});

	test("user-scope local/git sources or other package names are never accepted", () => {
		const local = fakePackage(claudeManifest());
		agentDirWith([local, "git:github.com/evil/pi-claude-code-provider", "npm:pi-claude-code-provider-evil@0.5.0",
			{ source: "./pi-claude-code-provider" }]);
		expect(defaultInstalledPackageLocator("pi-claude-code-provider", tempDir())).toEqual([]);
	});

	test("lookup failures become typed permanent errors", () => {
		expect(code(() => resolveClaude(() => { throw new Error("npm root failed"); }))).toBe("provider_metadata_invalid");
	});
});

describe("explicit --extension handling", () => {
	test("relative paths resolve against the child cwd and must be the declared entrypoint", () => {
		const cwd = path.dirname(STUB);
		const relative = path.join(path.basename(STUB), "extensions", "index.ts");
		const resolveWith = (args: string[], at = cwd) => resolveProviderExtensions({ selectedModel: CLAUDE, explicitModel: CLAUDE,
			claudeSelected: true, forwardedArgs: args, cwd: at, locateInstalled: () => { throw new Error("no lookup"); } });
		expect(resolveWith(["--extension", relative])).toEqual([]);
		expect(resolveWith(["-e", relative])).toEqual([]);
		// The same relative path from another cwd names nothing: normal lookup happens instead.
		expect(code(() => resolveWith(["-e", relative], tempDir()))).toBe("provider_metadata_invalid");
		const other = fakePackage(claudeManifest(), "extensions/index.ts");
		fs.writeFileSync(path.join(other, "extensions", "other.ts"), "export default function () {}\n");
		expect(code(() => resolveWith(["--extension", path.join(other, "extensions", "other.ts")]))).toBe("provider_metadata_invalid");
	});
});

describe("single selection predicate", () => {
	test("owned launch and dependency selection agree, including empty/whitespace env and task models", () => {
		const cases: Array<[{ model?: string }, Record<string, string | undefined>, string[], boolean]> = [
			[{ model: CLAUDE }, {}, [], true],
			[{ model: "" }, { ASYNC_SUBAGENTS_MODEL: "", PI_SUBAGENTS_MODEL: CLAUDE }, [], true],
			[{}, { ASYNC_SUBAGENTS_MODEL: "  ", PI_SUBAGENTS_MODEL: CLAUDE }, [], false],
			[{ model: "zai/glm" }, {}, ["--provider=pi-claude-code-provider"], true],
			[{ model: CLAUDE }, {}, ["-m", "zai/glm"], false],
			[{}, {}, ["--models", "pi-claude-code-provider/*"], true],
		];
		for (const [task, env, args, expected] of cases) {
			const saved = { a: process.env.ASYNC_SUBAGENTS_MODEL, p: process.env.PI_SUBAGENTS_MODEL };
			for (const [key, value] of Object.entries(env)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			try {
				expect(selectsOwnedProvider({ id: "x", task: "t", ...task }, args)).toBe(expected);
			} finally {
				if (saved.a === undefined) delete process.env.ASYNC_SUBAGENTS_MODEL; else process.env.ASYNC_SUBAGENTS_MODEL = saved.a;
				if (saved.p === undefined) delete process.env.PI_SUBAGENTS_MODEL; else process.env.PI_SUBAGENTS_MODEL = saved.p;
			}
		}
		expect(selectsClaudeProvider(undefined, [])).toBe(false);
	});
});

// ── spawnAgent matrix ─────────────────────────────────────────────────────

function fakePi(behavior: "ok" | "quota"): void {
	const script = path.join(tempDir(), "pi.js");
	fs.writeFileSync(script, behavior === "ok"
		? `process.stdin.on("data", () => { console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] })); setTimeout(() => process.exit(0), 0); });\nsetTimeout(() => {}, 1000);\n`
		: `process.stdin.on("data", () => { console.error("429 Too Many Requests: rate limit exceeded"); setTimeout(() => process.exit(1), 0); });\nsetTimeout(() => {}, 1000);\n`);
	process.argv[1] = script;
}

class OwnedBoundaryReached extends Error {}
function spawnForArgs(task: { id: string; model?: string }, extraArgs: string[] = [], locate = () => [STUB]) {
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	const cwd = tempDir();
	const runDir = path.join(cwd, "run");
	fs.mkdirSync(path.join(runDir, "prompts"), { recursive: true });
	let launched = false;
	let resolveCompleted!: (value: unknown) => void;
	const completed = new Promise((resolve) => { resolveCompleted = resolve; });
	try {
		spawnAgent(runDir, { ...task, task: "Do work" }, cwd, extraArgs, undefined, resolveCompleted, {
			ownedBinaries: FAKE_BINARIES, locateProviderPackagesForTest: locate,
			ownedLaunchForTest: () => { launched = true; throw new OwnedBoundaryReached(); },
		});
	} catch (error) {
		if (!(error instanceof OwnedBoundaryReached)) throw error;
	}
	const argsFile = path.join(runDir, task.id, "pi_args");
	return { argv: () => fs.readFileSync(argsFile, "utf8").split("\n"), launched: () => launched, completed, runDir, argsFile };
}
const count = (argv: string[], value: string) => argv.filter((arg) => arg === value).length;
const lastModels = (argv: string[]) => argv[argv.lastIndexOf("--models") + 1];

describe("child pi_args matrix (T1)", () => {
	test("Claude task: one provider extension, isolation preserved, pinned --models", () => {
		const run = spawnForArgs({ id: "claude", model: CLAUDE });
		const argv = run.argv();
		expect(run.launched()).toBe(true);
		expect(count(argv, STUB_ENTRY)).toBe(1);
		expect(argv).toContain("--no-extensions");
		expect(argv.some((arg) => arg.endsWith(path.join("model-tools", "index.ts")))).toBe(true);
		expect(argv.at(-1)?.endsWith("tool-guard.ts")).toBe(true);
		expect(argv.some((arg) => /pi-tools-suite[\\/](src[\\/])?index\.ts$/.test(arg))).toBe(false);
		expect(lastModels(argv)).toBe(CLAUDE);
		// The provider extension precedes the model/tool execution phase.
		expect(argv.indexOf(STUB_ENTRY)).toBeLessThan(argv.indexOf("--no-skills"));
	});

	test("override Claude -> ordinary provider drops the Claude dependency (and the owned launch)", async () => {
		fakePi("ok");
		const run = spawnForArgs({ id: "to-zai", model: CLAUDE }, ["--model", "zai/glm-5-turbo"], () => { throw new Error("no lookup"); });
		await run.completed;
		const argv = run.argv();
		expect(run.launched()).toBe(false);
		expect(argv).not.toContain(STUB_ENTRY);
		expect(lastModels(argv)).toBe("zai/glm-5-turbo");
	});

	for (const [label, extra] of [
		["--model value", ["--model", "pi-claude-code-provider/opus"]],
		["--model=value", ["--model=pi-claude-code-provider/opus"]],
		["-m value", ["-m", "pi-claude-code-provider/opus"]],
	] as const) {
		test(`override ordinary -> Claude via ${label} adds the dependency; the child sees --model`, () => {
			const run = spawnForArgs({ id: "to-claude", model: "zai/glm-5-turbo" }, [...extra]);
			const argv = run.argv();
			expect(run.launched()).toBe(true);
			expect(count(argv, STUB_ENTRY)).toBe(1);
			expect(argv).not.toContain("-m");
			expect(argv.some((arg) => arg.startsWith("--model="))).toBe(false);
			expect(argv[argv.lastIndexOf("--model") + 1]).toBe("pi-claude-code-provider/opus");
			expect(lastModels(argv)).toBe("pi-claude-code-provider/opus");
		});
	}

	test("explicit provider extension in extra args is not duplicated", () => {
		const run = spawnForArgs({ id: "explicit", model: CLAUDE }, ["--extension", STUB_ENTRY], () => { throw new Error("no lookup"); });
		expect(count(run.argv(), STUB_ENTRY)).toBe(1);
	});

	test("missing provider: permanent typed failure before any child artifact or launch", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const cwd = tempDir();
		const runDir = path.join(cwd, "run");
		fs.mkdirSync(runDir, { recursive: true });
		let launched = false;
		expect(() => spawnAgent(runDir, { id: "missing", task: "Do work", model: CLAUDE }, cwd, [], undefined, undefined, {
			ownedBinaries: FAKE_BINARIES, locateProviderPackagesForTest: () => [],
			ownedLaunchForTest: () => { launched = true; throw new Error("unreachable"); },
		})).toThrow(ProviderExtensionError);
		expect(launched).toBe(false);
		for (const name of ["pi_args", "prompt.md", "started_at", "owned-launch", "owned_launch"])
			expect(fs.existsSync(path.join(runDir, "missing", name))).toBe(false);
	});

	test("provider-changing fallback recomputes dependencies; a missing provider ends the chain without retry", async () => {
		fakePi("quota");
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		for (const installed of [true, false]) {
			resetSessionModelFallbacks();
			const cwd = tempDir();
			const runDir = path.join(cwd, "run");
			fs.mkdirSync(path.join(runDir, "prompts"), { recursive: true });
			const launches: string[][] = [];
			const retry = spawnAgentWithRetry(runDir, { id: "fb", task: "Do work", model: "zai/glm-5-turbo" }, cwd, undefined, {
				retry: { maxRetries: 3, backoffMs: 10 }, fallbackModels: [CLAUDE],
				ownedBinaries: FAKE_BINARIES, locateProviderPackagesForTest: () => (installed ? [STUB] : []),
				ownedLaunchForTest: (request) => { launches.push(request.args); throw new OwnedBoundaryReached(); },
			});
			const failure = await retry.done.then(() => undefined, (error: unknown) => error);
			if (installed) {
				expect(failure).toBeInstanceOf(OwnedBoundaryReached);
				expect(launches.length).toBe(1);
				const argv = fs.readFileSync(path.join(runDir, "fb", "pi_args"), "utf8").split("\n");
				expect(count(argv, STUB_ENTRY)).toBe(1);
				expect(lastModels(argv)).toBe(CLAUDE);
			} else {
				expect(failure).toBeInstanceOf(ProviderExtensionError);
				expect((failure as ProviderExtensionError).code).toBe("provider_not_installed");
				expect(launches.length).toBe(0);
				// No retry of the permanent failure: the retry counter never advanced.
				expect(fs.existsSync(path.join(runDir, "fb", "retry.log"))).toBe(false);
			}
		}
	}, 20_000);
});

describe("sub-agent tool guard", () => {
	test("denied tools are blocked at execution even if they became active later", async () => {
		const { default: guard } = await import("../../src/async-subagents/core/tool-guard.js");
		const handlers = new Map<string, (event: any) => unknown>();
		guard({ on: (name: string, handler: (event: any) => unknown) => handlers.set(name, handler) } as any);
		const toolCall = handlers.get("tool_call")!;
		expect(toolCall({ type: "tool_call", toolCallId: "1", toolName: "pi_claude_code_provider_web_search", input: {} }))
			.toMatchObject({ block: true });
		expect(toolCall({ type: "tool_call", toolCallId: "2", toolName: "async_subagents_spawn", input: {} })).toMatchObject({ block: true });
		expect(toolCall({ type: "tool_call", toolCallId: "3", toolName: "read", input: {} })).toBeUndefined();
	});
});
