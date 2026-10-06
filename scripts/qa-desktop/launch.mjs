import { spawn } from "node:child_process";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { checkedPath, ownedRoot, privateJson, readJson, safePath, validateBundle } from "./paths.mjs";
import { quitMacDesktopApp } from "../watch-all-desktop-quit.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const NATIVE_QA_CONTRACT = "PIX_DESKTOP_ISOLATED_QA_V1";

/** A capability gate, not a source fingerprint. Never boot a pre-isolation
 * Desktop just to discover that it would use the working WebView store. */
export async function requireNativeIsolation(executable) {
	const handle = await open(executable, "r");
	const needle = Buffer.from(NATIVE_QA_CONTRACT);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw new Error("invalid QA executable size");
		const buffer = Buffer.alloc(1024 * 1024);
		let tail = Buffer.alloc(0);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			const chunk = Buffer.concat([tail, buffer.subarray(0, bytesRead)]);
			if (chunk.includes(needle)) return;
			tail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - needle.length + 1)));
		}
	} finally { await handle.close(); }
	throw new Error("pinned build predates isolated QA support; wait for a successful native watch build and prepare again (no app launched)");
}
async function privatePath(root, path, kind) {
	await safePath(root, path, kind);
	const stat = await lstat(path);
	if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("QA profile and manifest must be private and owned by this user");
}

/** Only accept a private prepared manifest inside this checkout's owned run tree. */
export async function validateManifest(manifestPath, checkout) {
	checkout = await realpath(checkedPath(checkout));
	const path = checkedPath(manifestPath);
	const run = await ownedRoot(checkout, dirname(path));
	if (path !== join(run, "manifest.json")) throw new Error("expected private manifest.json");
	await privatePath(checkout, run, "directory");
	await privatePath(run, path, "file");
	const m = await readJson(path, 16384);
	if (m.version !== 1 || m.kind !== "pix-desktop-qa" || m.checkoutRoot !== checkout || m.runDir !== run
		|| !UUID.test(m.profileId) || m.profileDir !== join(run, "profile") || m.workspace !== join(run, "workspace")
		|| typeof m.app !== "string" || !basename(m.app).endsWith(".app") || m.app !== join(run, "native", basename(m.app))
		|| m.executable !== join(m.app, "Contents", "MacOS", "pix-desktop")
		|| m.source?.buildStatus !== "idle" || !Number.isSafeInteger(m.source?.ownerPid) || m.source.ownerPid <= 0
		|| typeof m.source.target !== "string" || typeof m.source.statePath !== "string") throw new Error("invalid QA manifest identity or layout");
	for (const directory of ["profile", "profile/home", "profile/home/.pi", "profile/home/.pi/agent", "profile/home/.config", "profile/home/.config/pi", "workspace"]) {
		await privatePath(run, join(run, directory), "directory");
	}
	await privatePath(run, join(m.profileDir, "profile.json"), "file");
	const profile = await readJson(join(m.profileDir, "profile.json"));
	if (profile.version !== 1 || profile.id !== m.profileId) throw new Error("profile identity does not match manifest");
	await safePath(run, m.app, "directory");
	await validateBundle(m.app, Date.now() + 15000);
	await requireNativeIsolation(m.executable);
	return m;
}

export function launchEnvironment(manifest, inherited = process.env) {
	// No ambient runtime/profile/credential overrides, including NODE_OPTIONS,
	// PIX_ACP_ENTRY and provider CLI homes, may reconnect QA to working state.
	const env = {};
	for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "TERM", "NO_COLOR"]) {
		if (inherited[key] !== undefined) env[key] = inherited[key];
	}
	const home = posix.join(manifest.profileDir, "home");
	return { ...env, PI_UI_QA: "1", PI_UI_QA_PROFILE_DIR: manifest.profileDir, HOME: home,
		PI_CODING_AGENT_DIR: posix.join(home, ".pi", "agent"), PI_CONFIG_DIR: posix.join(home, ".config", "pi"),
		XDG_CONFIG_HOME: posix.join(home, ".config"), XDG_CACHE_HOME: posix.join(home, ".cache"),
		XDG_DATA_HOME: posix.join(home, ".local", "share"), XDG_STATE_HOME: posix.join(home, ".local", "state"),
		PI_UI_QA_WORKSPACE: manifest.workspace };
}

export function matchesRuntime(marker, manifest, pid) {
	return marker?.version === 1 && marker.pid === pid && marker.executable === manifest.executable
		&& marker.profileDir === manifest.profileDir && marker.isolated === true
		&& marker.contract === NATIVE_QA_CONTRACT
		&& marker.appIdentifier === `dev.pix.desktop.qa.${manifest.profileId.replaceAll("-", "")}`;
}

/** No stale-lock takeover: a crashed supervisor cannot authorize profile reuse. */
export async function acquireLaunchLock(manifest) {
	const path = join(manifest.profileDir, "launch.lock");
	try { await mkdir(path, { mode: 0o700 }); }
	catch (error) {
		if (error.code === "EEXIST") throw new Error("QA profile is locked; prepare a new run (no automatic stale-lock reuse)");
		throw error;
	}
	try { await privateJson(join(path, "owner.json"), { version: 1, pid: process.pid, profileId: manifest.profileId }); }
	catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
	return async () => { await rm(path, { recursive: true, force: true }); };
}

/** Direct child inherits runner PGID. Quit and fallback signals target only that child. */
export async function launchDesktop(options, dependencies = {}) {
	const { spawnChild = spawn, quit = quitMacDesktopApp, wait = sleep, now = Date.now,
		signals = process, startupTimeoutMs = 15000, onReady = () => {} } = dependencies;
	const manifest = await validateManifest(options.manifest, options.checkout);
	const unlock = await acquireLaunchLock(manifest);
	let child, exited = false, stopping, cancelled;
	let resolveExit;
	const exit = new Promise((resolve) => { resolveExit = resolve; });
	const finish = (result) => { if (!exited) { exited = true; resolveExit(result); } };
	const waitForExit = async (_pid, timeout) => {
		if (exited) return true;
		if (!timeout) return false;
		const controller = new AbortController();
		try { await Promise.race([exit, wait(timeout, undefined, { signal: controller.signal })]); }
		finally { controller.abort(); }
		return exited;
	};
	const stop = () => stopping ||= (async () => {
		if (!child || exited) return;
		try { await quit(child.pid, waitForExit); }
		catch {
			if (!exited) child.kill("SIGTERM");
			if (!(await waitForExit(child.pid, 2000)) && !exited) child.kill("SIGKILL");
			if (!(await waitForExit(child.pid, 2000))) throw new Error("owned QA child did not exit; profile lock retained");
		}
	})();
	const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
		const handler = () => { cancelled = signal; void stop().catch(() => {}); };
		signals.on(signal, handler);
		return [signal, handler];
	});
	try {
		await rm(join(manifest.profileDir, "runtime.json"), { force: true });
		await rm(join(manifest.runDir, "identity.json"), { force: true });
		if (cancelled) throw new Error(`QA launch cancelled by ${cancelled}`);
		child = spawnChild(manifest.executable, [], { cwd: manifest.workspace, env: launchEnvironment(manifest, options.env), detached: false, stdio: "inherit" });
		child.once("exit", (code, signal) => finish({ code, signal }));
		child.once("error", () => finish({ code: 1, error: "could not spawn pinned QA executable" }));
		if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("could not spawn pinned QA executable");
		await privateJson(join(manifest.profileDir, "launch.json"), { version: 1, pid: child.pid, executable: manifest.executable, profileId: manifest.profileId });
		const deadline = now() + startupTimeoutMs;
		let ready = false;
		while (!cancelled && !exited && now() < deadline) {
			try {
				const path = join(manifest.profileDir, "runtime.json");
				await privatePath(manifest.profileDir, path, "file");
				const marker = await readJson(path);
				if (!matchesRuntime(marker, manifest, child.pid)) throw new Error("QA runtime isolation marker does not match owned child");
				// The runner call returns after native teardown removes runtime.json.
				// Retain only the verified, credential-free identity for that handoff.
				await privateJson(join(manifest.runDir, "identity.json"), {
					version: 1, contract: NATIVE_QA_CONTRACT, pid: child.pid,
					executable: manifest.executable, profileDir: manifest.profileDir,
					profileId: manifest.profileId, appIdentifier: marker.appIdentifier, isolated: true,
				});
				ready = true;
				break;
			} catch (error) { if (error.code !== "ENOENT") throw error; }
			await wait(Math.min(50, Math.max(1, deadline - now())));
		}
		if (cancelled) throw new Error(`QA launch cancelled by ${cancelled}`);
		if (!ready) throw new Error("pinned Desktop did not prove isolated native profile support; owned QA app closed, working app not tested");
		await onReady({ pid: child.pid, executable: manifest.executable, profileId: manifest.profileId, isolated: true,
			identityPath: join(manifest.runDir, "identity.json") });
		const result = await exit;
		if (cancelled) return { code: cancelled === "SIGINT" ? 130 : cancelled === "SIGHUP" ? 129 : 143, signal: cancelled };
		if (result.error) throw new Error(result.error);
		return result;
	} finally {
		try { await stop(); }
		finally {
			for (const [signal, handler] of listeners) signals.removeListener(signal, handler);
			if (!child || exited) await unlock();
		}
	}
}
