// Provider dependency injection for isolated children (plan P2–P6, T1).
// Offline and deterministic: the Claude provider is the vendored local module
// (trusted suite-relative entrypoint, no user/project package lookup); the
// installed-package locator remains a pure test seam for staged copies/stubs,
// the Claude path stops at the (mocked) owned-launch boundary, and non-Claude
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
	claudeProviderLocalRoot,
	localClaudeProviderModule,
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
const localOnly = test;

const roots: string[] = [];
const originalPlatform = process.platform;
const originalArgv1 = process.argv[1];
const originalEnvModel = process.env.ASYNC_SUBAGENTS_MODEL;
const describeOwnedSpawnMatrix = process.platform === "win32" ? describe.skip : describe;
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
const resolveClaude = (locate: () => string[], forwardedArgs: string[] = [], cwd: string = tempDir()) =>
	resolveProviderExtensions({ selectedModel: CLAUDE, explicitModel: CLAUDE, claudeSelected: true, forwardedArgs, cwd, locateInstalled: locate });
/** Default (production) resolution: no seam, no explicit args. */
const resolveLocalClaude = (forwardedArgs: string[] = [], cwd?: string, explicitModel?: string) =>
	resolveProviderExtensions({ selectedModel: explicitModel ?? CLAUDE, explicitModel, claudeSelected: true, forwardedArgs, cwd: cwd ?? tempDir() });
const code = (fn: () => unknown) => {
	try { fn(); } catch (error) { return error instanceof ProviderExtensionError ? error.code : `other:${String(error)}`; }
	return "no-error";
};

describe("provider dependency resolver", () => {
	test("Claude resolves exactly one validated entrypoint through the test-seam lookup", () => {
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

	test("an explicitly supplied seam package extension is validated and never duplicated", () => {
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
		expect(error.message.length).toBeLessThanOrEqual(1_000);
	});

	test("unsupported CLI spellings are normalized to the child-accepted form", () => {
		expect(normalizeProviderArgs(["-m", "a/b", "--model=c/d", "--provider=p", "--thinking", "high"]))
			.toEqual(["--model", "a/b", "--model", "c/d", "--provider", "p", "--thinking", "high"]);
		expect(normalizeProviderArgs(["--models", "x/*"])).toEqual(["--models", "x/*"]);
	});

	test("seam packages resolve explicit --extension against the child cwd; only the declared entrypoint is accepted", () => {
		const cwd = path.dirname(STUB);
		const relative = path.join(path.basename(STUB), "extensions", "index.ts");
		const thrower = () => { throw new Error("no lookup"); };
		expect(resolveClaude(thrower, ["--extension", relative], cwd)).toEqual([]);
		expect(resolveClaude(thrower, ["-e", relative], cwd)).toEqual([]);
		// The same relative path from another cwd names nothing: the lookup runs instead.
		expect(code(() => resolveClaude(thrower, ["-e", relative]))).toBe("provider_metadata_invalid");
		const other = fakePackage(claudeManifest(), "extensions/index.ts");
		fs.writeFileSync(path.join(other, "extensions", "other.ts"), "export default function () {}\n");
		expect(code(() => resolveClaude(thrower, ["--extension", path.join(other, "extensions", "other.ts")], cwd))).toBe("provider_metadata_invalid");
	});
});

describe("vendored local module resolution (default)", () => {
	localOnly("Claude resolves the module's public standalone entrypoint (index.ts), including env-model selection", () => {
		const local = localClaudeProviderModule(CLAUDE);
		expect(path.basename(local.standalone)).toBe("index.ts");
		expect(local.standalone.startsWith(`${local.root}${path.sep}`)).toBe(true);
		expect(resolveLocalClaude()).toEqual([local.standalone]);
		// A model sourced only from the environment still selects the provider.
		const envModel = resolveProviderExtensions({ selectedModel: CLAUDE, explicitModel: undefined,
			claudeSelected: true, forwardedArgs: [], cwd: tempDir() });
		expect(envModel).toEqual([local.standalone]);
		expect(resolveProviderExtensions({ selectedModel: "pi-claude-code-provider/opus", explicitModel: undefined,
			claudeSelected: true, forwardedArgs: [], cwd: tempDir() })).toEqual([local.standalone]);
	});

	localOnly("explicit local entries are deduped, never injected twice", () => {
		const local = localClaudeProviderModule(CLAUDE);
		expect(resolveLocalClaude(["--extension", local.standalone])).toEqual([]);
		expect(resolveLocalClaude(["--extension", local.entry])).toEqual([]);
		expect(resolveLocalClaude(["-e", "index.ts"], local.root)).toEqual([]);
		// Any other file of the vendored package is not the public entrypoint.
		expect(code(() => resolveLocalClaude(["--extension", path.join(claudeProviderLocalRoot(), "package.json")])))
			.toBe("provider_metadata_invalid");
	});

	localOnly("checks every explicit entry, including directories and both local aliases", () => {
		const local = localClaudeProviderModule(CLAUDE);
		const old = fakePackage(claudeManifest());
		for (const entries of [
			[local.standalone, path.join(old, "extensions/index.ts")],
			[path.join(old, "extensions/index.ts"), local.standalone],
			[local.standalone, local.entry],
			[old],
		]) {
			expect(code(() => resolveLocalClaude(entries.flatMap(entry => ["--extension", entry]))))
				.toBe("provider_metadata_invalid");
		}
	});

	test("an explicit old npm provider extension is rejected (no double registration)", () => {
		const npmCopy = fakePackage(claudeManifest());
		const error = (() => { try { resolveLocalClaude(["--extension", path.join(npmCopy, "extensions", "index.ts")]); } catch (e) { return e as ProviderExtensionError; } })()!;
		expect(error).toBeInstanceOf(ProviderExtensionError);
		expect(error.code).toBe("provider_metadata_invalid");
		expect(error.permanent).toBe(true);
		expect(error.message).toContain("vendored local module is injected instead");
		// The rejection does not depend on the local module being present.
		const nested = fakePackage(claudeManifest());
		expect(code(() => resolveLocalClaude(["-e", path.join(nested, "extensions", "index.ts")], tempDir()))).toBe("provider_metadata_invalid");
	});

	localOnly("no user/project package lookup: Pi package sources cannot supply the provider", () => {
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = tempDir();
		const evil = fakePackage(claudeManifest());
		fs.mkdirSync(path.join(agentDir, "npm", "node_modules"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-claude-code-provider@0.5.0"] }));
		fs.symlinkSync(evil, path.join(agentDir, "npm", "node_modules", "pi-claude-code-provider"));
		// A repository cwd with project package settings is equally ignored.
		const repo = tempDir();
		fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ packages: [evil, "npm:pi-claude-code-provider@0.5.0"] }));
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const local = localClaudeProviderModule(CLAUDE);
			expect(resolveLocalClaude([], repo)).toEqual([local.standalone]);
			expect(resolveLocalClaude([], repo)[0]).not.toContain("provider-ext-");
		} finally {
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
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

describeOwnedSpawnMatrix("child pi_args matrix (T1)", () => {
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
