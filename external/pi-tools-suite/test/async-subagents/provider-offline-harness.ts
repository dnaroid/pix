import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProviderLocalRoot } from "../../src/async-subagents/core/provider-extensions.js";
import { localNode, rpcProbe, stopAndConfirm } from "./provider-offline-rpc.ts";
import { applyNativeProviderPatch } from "./provider-native-patch.ts";

const suite = fileURLToPath(new URL("../..", import.meta.url));
const root = resolve(suite, "../..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const fixture = fileURLToPath(new URL("./fixtures/provider-offline-cli.mjs", import.meta.url));
/** Anchors pin the characterized UNMODIFIED 0.5.0 release (external snapshots only). */
const anchors = {
	"src/claude-process.ts": "57b18c7c2f8d6a2c41747f2a1aa6e0762375e4003cf7386db87eb690c2c23fd7",
	"src/process-utils.ts": "20937a411fd3223f19061f6fc65573e19e1d16bf9401cdd79f1d5bcd61a34ed0",
};
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function files(dir: string, prefix = ""): string[] {
	return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((item) => {
		const path = join(prefix, item.name);
		if (item.isSymbolicLink()) throw new Error(`Snapshot has unexpected symlink: ${path}`);
		return item.isDirectory() ? files(dir, path) : item.isFile() ? [path] : [];
	}).sort();
}

/** The vendored patched provider module inside the tools suite (default source). */
export const localProviderRoot = claudeProviderLocalRoot();
export function localProviderAvailable(): boolean {
	if (!existsSync(join(localProviderRoot, "package.json"))) throw new Error("Required vendored Claude provider is missing");
	return true;
}

export interface ProviderSnapshotSource {
	/** Absolute provider package root to stage. */
	snapshot: string;
	/** External snapshot of the characterized unmodified release (hash-anchored). */
	pinned: boolean;
}

/**
 * Default provider source: the vendored local module, unless an explicit
 * external snapshot is requested for the unmodified-release characterization.
 * The local module is required: a missing source is a regression, not a skip.
 */
export function providerSnapshotSource(env: NodeJS.ProcessEnv = process.env): ProviderSnapshotSource {
	const external = env.PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT;
	if (external !== undefined) return { snapshot: external, pinned: true };
	localProviderAvailable();
	return { snapshot: localProviderRoot, pinned: false };
}

export function stageSnapshot(snapshot: string, work: string, pinned = true): string {
	const manifest = JSON.parse(readFileSync(join(snapshot, "package.json"), "utf8"));
	if (manifest.name !== "pi-claude-code-provider" || manifest.version !== "0.5.0" ||
		JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./extensions/index.ts"])) {
		throw new Error("Unrecognized provider snapshot metadata; only the characterized offline baseline is characterized");
	}
	// The vendored module is intentionally patched; only an external snapshot of
	// the investigated release is hash-pinned. Local staging still verifies the
	// copy byte-for-byte below: the repository is the trust boundary.
	if (pinned) {
		for (const [path, expected] of Object.entries(anchors)) {
			if (hash(join(snapshot, path)) !== expected) throw new Error(`Provider snapshot hash mismatch: ${path}`);
		}
	}
	const standalone = existsSync(join(snapshot, "index.ts"));
	const target = join(work, "provider");
	mkdirSync(target);
	const entries = ["package.json", ...(standalone ? ["index.ts"] : []), "src", "extensions", "bridge"];
	for (const entry of entries) cpSync(join(snapshot, entry), join(target, entry), { recursive: true, dereference: false });
	const listed = ["package.json", ...(standalone ? ["index.ts"] : []), ...files(snapshot, "src"), ...files(snapshot, "extensions"), ...files(snapshot, "bridge")];
	const sourceHashes = Object.fromEntries(listed.map((path) => [path, hash(join(snapshot, path))]));
	const targetFiles = ["package.json", ...(standalone ? ["index.ts"] : []), ...files(target, "src"), ...files(target, "extensions"), ...files(target, "bridge")];
	if (JSON.stringify(Object.keys(sourceHashes)) !== JSON.stringify(targetFiles) ||
		targetFiles.some((path) => hash(join(target, path)) !== sourceHashes[path])) throw new Error("Provider staged source differs from snapshot");
	writeFileSync(join(work, "snapshot-manifest.json"), JSON.stringify({ name: manifest.name, version: manifest.version, hashes: sourceHashes }, null, 2), { mode: 0o600 });
	const dependencies = manifest.peerDependencies as Record<string, string>;
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
		if (!dependencies?.[name]) throw new Error(`Snapshot missing declared peer ${name}`);
		const installed = join(root, "node_modules", name);
		if (!existsSync(installed)) throw new Error(`Required local provider peer missing: ${name}`);
		const link = join(target, "node_modules", name);
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(installed, link, "dir");
	}
	// The public standalone entry is what production children load; fall back to
	// the declared entrypoint only for snapshots without one.
	return standalone ? join(target, "index.ts") : join(target, "extensions/index.ts");
}

type RecordLine = Record<string, any>;
export async function runOffline(source: ProviderSnapshotSource, code: 0 | 7, native = false): Promise<{ rpc: RecordLine[]; calls: RecordLine[] }> {
	const work = mkdtempSync(join(tmpdir(), "pi-provider-offline-"));
	let child: ChildProcess | undefined;
	let closed: Promise<void> | undefined;
	let result: { rpc: RecordLine[]; calls: RecordLine[] } | undefined;
	let problem: unknown;
	try {
		const extension = stageSnapshot(source.snapshot, work, source.pinned);
		let nativeBinary: string | undefined;
		if (native) {
			if (process.platform !== "darwin") throw new Error("Native provider test only supports macOS");
			nativeBinary = join(work, "relay");
			execFileSync("clang", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2",
				fileURLToPath(new URL("./fixtures/provider-native-relay.c", import.meta.url)), "-o", nativeBinary], { timeout: 10_000 });
			applyNativeProviderPatch(join(work, "provider"));
		}
		const home = join(work, "home");
		const agent = join(work, "agent");
		const cwd = join(work, "cwd");
		for (const path of [home, agent, cwd]) mkdirSync(path);
		writeFileSync(join(home, "fake-exit-code"), String(code));
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enableInstallTelemetry: false, enableAnalytics: false, extensions: [], packages: [], skills: [], prompts: [], themes: [], defaultTools: [] }));
		// Do not inherit PATH, HOME, auth/config, proxy, project extensions or ambient Pi variables.
		const node = localNode();
		const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(work, "sessions"),
			PI_CLAUDE_CODE_PROVIDER_PATH: fixture, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
			PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: work, LANG: "C", NO_COLOR: "1",
			...(nativeBinary ? { PI_PROVIDER_TEST_NATIVE_RELAY: nativeBinary } : {}) };
		child = spawn(node, [cli, "--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-extensions",
			"--extension", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--no-tools", "--provider", "pi-claude-code-provider", "--model", "sonnet", "--models", "pi-claude-code-provider/sonnet"],
		{ cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		closed = new Promise<void>((resolveClose) => child!.once("close", () => resolveClose()));
		const records = await rpcProbe(child);
		const calls = readdirSync(home).filter((name) => name.startsWith("fake-cli-")).map((name) => JSON.parse(readFileSync(join(home, name), "utf8")));
		result = { rpc: records, calls };
	} catch (error) { problem = error; }
	try {
		// Once Pi was spawned, conservatively require all three probes and the request.
		// Early failure before that evidence retains the workdir, never guesses cleanup.
		await stopAndConfirm(child, closed, join(work, "home"), 10_000, child ? 4 : 0);
		rmSync(work, { recursive: true, force: true });
	} catch (error) {
		throw new Error(`Offline cleanup failed; retained ${work}: ${String(error)}; original error: ${String(problem)}`);
	}
	if (problem) throw problem;
	return result!;
}
