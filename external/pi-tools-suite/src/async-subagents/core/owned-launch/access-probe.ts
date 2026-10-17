// Launchd access probe for owned-launch.
//
// launchd-started jobs do not inherit the privacy (TCC) grants of the Pi/Pix
// process that bootstraps them. A project on an external/removable volume (or
// another TCC-protected location) is therefore readable by Pi but NOT by the
// owned-launch supervisor/worker, which makes the owned sub-agent unusable.
// This module asks launchd itself: it bootstraps a tiny throwaway job from a
// private /tmp directory that lists each target directory and reports
// `ok`/`denied`. The probe is asynchronous, bounded, cached per directory set,
// and never runs on a hot path.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** `unknown` means the probe could not decide (timeout/IO); callers fail closed. */
export type LaunchdAccess = "ok" | "denied" | "unknown";

export interface LaunchdAccessProbeDeps {
	/** Runs /bin/launchctl with args; resolves its exit status. */
	launchctl: (args: string[]) => Promise<number>;
	/** Directory that launchd itself can always read (plist + result file). */
	tmpRoot: string;
	/** Upper bound for the job to report a verdict. */
	resultTimeoutMs: number;
	uid: number;
}

const PROBE_LABEL_PREFIX = "org.pix.launchd-probe.";
const PROBE_SCRIPT = [
	'out="$1"; shift',
	'for d in "$@"; do',
	'  if ! /bin/ls "$d" >/dev/null 2>&1; then printf denied > "$out.tmp"; /bin/mv "$out.tmp" "$out"; exit 0; fi',
	"done",
	'printf ok > "$out.tmp"; /bin/mv "$out.tmp" "$out"',
].join("\n");

function defaultLaunchctl(args: string[]): Promise<number> {
	return new Promise((resolve) => {
		execFile("/bin/launchctl", args, { timeout: 5_000, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } }, (error) => {
			if (!error) return resolve(0);
			const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
			resolve(typeof code === "number" ? code : -1);
		});
	});
}

function defaultDeps(): LaunchdAccessProbeDeps {
	return { launchctl: defaultLaunchctl, tmpRoot: "/tmp", resultTimeoutMs: 5_000, uid: process.getuid?.() ?? -1 };
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function probePlist(label: string, args: string[]): string {
	const programArguments = args.map((arg) => `<string>${xmlEscape(arg)}</string>`).join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
		`<plist version="1.0"><dict><key>Label</key><string>${xmlEscape(label)}</string>` +
		`<key>ProgramArguments</key><array>${programArguments}</array><key>RunAtLoad</key><true/></dict></plist>\n`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LaunchdAccessProbeResult {
	access: LaunchdAccess;
	/** True when the verdict came from the job itself and may be cached. */
	definitive: boolean;
}

/** One uncached probe of whether a launchd job can list every directory. */
export async function probeLaunchdAccess(dirs: string[], deps: LaunchdAccessProbeDeps = defaultDeps()): Promise<LaunchdAccessProbeResult> {
	let temp: string | undefined;
	let label: string | undefined;
	let bootstrapped = false;
	try {
		temp = await fs.promises.mkdtemp(path.join(deps.tmpRoot, "pix-launchd-probe-"));
		await fs.promises.chmod(temp, 0o700);
		label = `${PROBE_LABEL_PREFIX}${randomUUID()}`;
		const out = path.join(temp, "result");
		const plist = path.join(temp, "probe.plist");
		await fs.promises.writeFile(plist, probePlist(label, ["/bin/sh", "-c", PROBE_SCRIPT, "launchd-probe", out, ...dirs]), { mode: 0o600 });
		const rc = await deps.launchctl(["bootstrap", `gui/${deps.uid}`, plist]);
		// launchd itself refused the job (no GUI domain, policy): an owned launch
		// would fail the same way, so it is unusable for this run. Not cached.
		if (rc !== 0) return { access: "denied", definitive: false };
		bootstrapped = true;
		const deadline = Date.now() + deps.resultTimeoutMs;
		while (Date.now() < deadline) {
			const verdict = await fs.promises.readFile(out, "utf8").catch(() => undefined);
			if (verdict === "ok" || verdict === "denied") return { access: verdict, definitive: true };
			await sleep(50);
		}
		return { access: "unknown", definitive: false };
	} catch {
		return { access: "unknown", definitive: false };
	} finally {
		if (bootstrapped && label) await deps.launchctl(["bootout", `gui/${deps.uid}/${label}`]).catch(() => -1);
		if (temp) await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => {});
	}
}

const cache = new Map<string, LaunchdAccess>();
const inFlight = new Map<string, Promise<LaunchdAccess>>();
let probeOverride: ((dirs: string[]) => Promise<LaunchdAccess>) | undefined;

/** Test seam: replace the probe process-wide (undefined restores it) and clear the cache. */
export function setLaunchdAccessProbeForTest(probe: ((dirs: string[]) => Promise<LaunchdAccess>) | undefined): void {
	probeOverride = probe;
	cache.clear();
	inFlight.clear();
}

function canonical(dir: string): string {
	try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

/**
 * Whether launchd-started jobs can access every directory. Definitive verdicts
 * are cached for the process lifetime; concurrent callers share one probe.
 */
export function launchdAccess(dirs: string[]): Promise<LaunchdAccess> {
	const targets = [...new Set(dirs.map(canonical))].sort();
	const key = targets.join("\0");
	const cached = cache.get(key);
	if (cached) return Promise.resolve(cached);
	const pending = inFlight.get(key);
	if (pending) return pending;
	const run = (async () => {
		if (probeOverride) {
			const access = await probeOverride(targets);
			if (access !== "unknown") cache.set(key, access);
			return access;
		}
		const result = await probeLaunchdAccess(targets);
		if (result.definitive) cache.set(key, result.access);
		return result.access;
	})().finally(() => inFlight.delete(key));
	inFlight.set(key, run);
	return run;
}
