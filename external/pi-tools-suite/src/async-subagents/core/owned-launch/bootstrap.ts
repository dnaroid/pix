// Async native bootstrap for owned-launch. The bridge, supervisor, and
// worker gate are C programs shipped as sources with the package; the
// production bootstrap compiles them into a private 0700 cache directory
// keyed by a hash of the sources. Compilation happens in a child process —
// never synchronously on the parent's UI/event thread — and fails closed
// with a documented error when no toolchain is available (macOS with Xcode
// Command Line Tools is a hard requirement for owned-launch; see
// README.md "Limits").
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSecureDir } from "./label.js";

export interface OwnedLaunchBinaries {
	bridge: string;
	supervisor: string;
	gate: string;
}

const NATIVE_SOURCES = ["owned-launch-bridge.c", "owned-launch-supervisor.c", "owned-launch-worker-gate.c"] as const;
const COMPILE_VERSION_SALT = "owned-launch-v1";

/** Directory containing the native C sources shipped with the package. */
export function ownedLaunchNativeDir(): string {
	return join(pathOf(import.meta.url), "native");
}

function pathOf(url: string): string {
	return fileURLToPath(new URL(".", url));
}

function defaultCacheRoot(): string {
	return join(homedir(), ".cache", "pi-tools-suite", "owned-launch");
}

function sourcesFingerprint(nativeDir: string): string {
	const hash = createHash("sha256");
	hash.update(COMPILE_VERSION_SALT);
	for (const name of NATIVE_SOURCES) {
		hash.update(name);
		hash.update(readFileSync(join(nativeDir, name)));
	}
	hash.update(readFileSync(join(nativeDir, "owned-launch-common.h")));
	return hash.digest("hex").slice(0, 32);
}

async function compileOne(nativeDir: string, source: string, output: string, env: NodeJS.ProcessEnv): Promise<void> {
	const argv = [
		"xcrun",
		"clang",
		"-std=c11",
		"-Wall",
		"-Wextra",
		"-Werror",
		"-I",
		nativeDir,
		join(nativeDir, source),
		"-lbsm",
		"-o",
		output,
	];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"], env });
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (stderr.length > 8192) stderr = stderr.slice(0, 8192);
		});
		child.once("error", (error) => reject(new Error(`owned-launch toolchain missing (${argv[0]}): ${error.message}`)));
		child.once("exit", (code, signal) => {
			if (code === 0) return resolve();
			reject(new Error(`owned-launch native build failed for ${source}: exit=${code ?? signal}\n${stderr.trim()}`));
		});
	});
}

/**
 * Compile the three native programs into `outDir` (0700, must be private).
 * Runs the compiler in child processes; safe to await from async code.
 */
export async function compileOwnedLaunchBinaries(outDir: string, env: NodeJS.ProcessEnv = process.env): Promise<OwnedLaunchBinaries> {
	const nativeDir = ownedLaunchNativeDir();
	for (const name of NATIVE_SOURCES) {
		if (!existsSync(join(nativeDir, name))) {
			throw new Error(`owned-launch native source missing: ${join(nativeDir, name)}`);
		}
	}
	ensureSecureDir(outDir);
	const bins: OwnedLaunchBinaries = { bridge: "", supervisor: "", gate: "" };
	const entries: Array<[keyof OwnedLaunchBinaries, string]> = [
		["bridge", "owned-launch-bridge"],
		["supervisor", "owned-launch-supervisor"],
		["gate", "owned-launch-worker-gate"],
	];
	for (const [key, stem] of entries) {
		const final = join(outDir, stem);
		// Private per-build temp name: concurrent builders (other Pi processes)
		// never share or clobber a temp file, a crashed build's leftover can
		// never block later builds, and the atomic rename publishes a complete
		// executable (identical content, so the last publisher wins harmlessly).
		const tmp = join(outDir, `.${stem}.build-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
		try {
			await compileOne(nativeDir, `${stem}.c`, tmp, env);
			chmodSync(tmp, 0o700);
			renameSync(tmp, final);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
		bins[key] = final;
	}
	return bins;
}

function binariesPresent(dir: string): boolean {
	try {
		const needed = ["owned-launch-bridge", "owned-launch-supervisor", "owned-launch-worker-gate"];
		for (const stem of needed) {
			const st = statSync(join(dir, stem), { throwIfNoEntry: false });
			if (!st?.isFile() || !(st.mode & 0o111)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

const inFlightBuilds = new Map<string, Promise<OwnedLaunchBinaries>>();

/**
 * Return the cached native binaries for the current sources, building them
 * in a child process when needed. Fails closed (rejects) when the toolchain
 * is unavailable: owned-launch never degrades to an unsafe fallback.
 */
export async function ensureOwnedLaunchBinaries(options: { cacheRoot?: string; env?: NodeJS.ProcessEnv } = {}): Promise<OwnedLaunchBinaries> {
	const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
	ensureSecureDir(cacheRoot);
	const fingerprint = sourcesFingerprint(ownedLaunchNativeDir());
	const dir = join(cacheRoot, fingerprint);
	if (binariesPresent(dir)) {
		return { bridge: join(dir, "owned-launch-bridge"), supervisor: join(dir, "owned-launch-supervisor"), gate: join(dir, "owned-launch-worker-gate") };
	}
	// Single-flight per cache dir: concurrent first launches in this process
	// await one build instead of racing it (failures are not cached).
	let build = inFlightBuilds.get(dir);
	if (!build) {
		build = compileOwnedLaunchBinaries(dir, options.env).finally(() => inFlightBuilds.delete(dir));
		inFlightBuilds.set(dir, build);
	}
	return build;
}
