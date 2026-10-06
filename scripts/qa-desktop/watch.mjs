import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { WATCH_TEMP_PREFIX, WATCH_OWNER_FILE } from "../watch-all-temp.mjs";
import { parseDesktopWatchState } from "../watch-all-state.mjs";
import { checkedPath, contained, readJson, safePath } from "./paths.mjs";

const exec = promisify(execFile);
export const STATE_FILE = "desktop-watch-state.json";

/** Bounded exact-PID inspection also supports old {pid}-only owner markers. */
export async function probeWatchOwner(pid) {
	try {
		const options = { timeout: 2000, maxBuffer: 16384 };
		const { stdout: command } = await exec("/bin/ps", ["-p", String(pid), "-o", "command="], options);
		const { stdout: cwdFields } = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], options);
		const cwd = cwdFields.split("\n").find((line) => line.startsWith("n"))?.slice(1);
		return cwd && command.trim() ? { command: command.trim(), cwd: await realpath(cwd) } : undefined;
	} catch { return undefined; }
}

export async function verifyOwner(statePath, checkout, tempRoot, probe = probeWatchOwner, { deadline = Infinity, now = Date.now } = {}) {
	const state = checkedPath(statePath);
	const directory = dirname(state);
	if (basename(state) !== STATE_FILE || dirname(directory) !== tempRoot || !basename(directory).startsWith(WATCH_TEMP_PREFIX)) {
		throw new Error("state must belong to a direct pix-watch-all-* child of the canonical system temp root");
	}
	await safePath(tempRoot, directory, "directory");
	const ownerPath = await safePath(directory, join(directory, WATCH_OWNER_FILE), "file");
	const owner = await readJson(ownerPath);
	if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid watcher owner PID");
	if (owner.checkoutRoot !== undefined && owner.checkoutRoot !== checkout) throw new Error("watcher owner is for a different checkout");
	const remaining = Math.min(2000, deadline - now());
	if (remaining <= 0) throw new Error("watcher discovery deadline exceeded");
	let timer;
	let process;
	try {
		process = await Promise.race([
			Promise.resolve().then(() => probe(owner.pid)),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("watcher probe timed out")), remaining); }),
		]);
	} finally { clearTimeout(timer); }
	if (!process) throw new Error("watcher owner is dead or cannot be inspected");
	// Metadata alone is not liveness/identity proof; inspect the owner even for new markers.
	const escaped = checkout.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const supervisor = new RegExp(`^(?:\\S*\\/)?node(?:\\s+[^\\s]+)*\\s+(?:${escaped}/)?scripts/watch-all\\.mjs(?:\\s|$)`, "u");
	if (process.cwd !== checkout || !supervisor.test(process.command)) throw new Error("live owner is not watch:all for this canonical checkout");
	return { statePath: state, directory, ownerPid: owner.pid };
}

export async function discoverWatcher({ checkout, state, tempRoot, probe = probeWatchOwner, deadline, now }) {
	const root = await realpath(tempRoot ?? tmpdir());
	if (state) {
		// Accept macOS /var spelling by canonicalizing only its system-temp prefix.
		const supplied = checkedPath(state);
		const canonicalState = join(root, basename(dirname(supplied)), basename(supplied));
		if ((await realpath(dirname(dirname(supplied)))) !== root) throw new Error("state is outside system temp");
		return { ...await verifyOwner(canonicalState, checkout, root, probe, { deadline, now }), tempRoot: root };
	}
	const matches = [];
	const entries = await readdir(root, { withFileTypes: true });
	if (entries.length > 10000) throw new Error("temporary-root discovery exceeds limit; specify --state");
	if (entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(WATCH_TEMP_PREFIX)).length > 32) throw new Error("watcher candidate discovery exceeds limit; specify --state");
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(WATCH_TEMP_PREFIX)) continue;
		if (deadline !== undefined && (now ?? Date.now)() >= deadline) throw new Error("watcher discovery deadline exceeded");
		try { matches.push(await verifyOwner(join(root, entry.name, STATE_FILE), checkout, root, probe, { deadline, now })); }
		catch { /* Unrelated/dead/unsafe roots are never candidates. */ }
	}
	if (matches.length !== 1) throw new Error(matches.length
		? "multiple live watch:all owners for this checkout; select one with --state <desktop-watch-state.json>"
		: "no verifiable live watch:all owner for this checkout; check its terminal and pass --state <desktop-watch-state.json> (QA never starts a watcher)");
	return { ...matches[0], tempRoot: root };
}

export async function successfulState(watcher, checkout, probe, budget) {
	await verifyOwner(watcher.statePath, checkout, watcher.tempRoot, probe, budget);
	await safePath(watcher.directory, watcher.statePath, "file");
	const state = parseDesktopWatchState(await readJson(watcher.statePath));
	if (!state) throw new Error("invalid watcher state");
	if (state.buildStatus === "failed") throw new Error("watch:all build failed; fix it in the watcher terminal before preparing QA");
	if (state.buildStatus && state.buildStatus !== "idle") return undefined;
	const target = checkedPath(state.target);
	if (!contained(watcher.directory, target)) throw new Error("published target escapes watcher ownership");
	const bundle = dirname(dirname(dirname(target)));
	// Never select raw cargo output or a non-.app artifact.
	if (!basename(bundle).endsWith(".app") || target !== join(bundle, "Contents", "MacOS", "pix-desktop")) throw new Error("published target is not the copied macOS .app executable");
	await safePath(watcher.directory, target, "file");
	return { target, bundle, buildStatus: "idle" };
}
