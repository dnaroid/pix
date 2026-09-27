// Durable lifecycle markers for the owned-launch run directory. The cancel
// marker is the disk leg of the stop contract: stop() fsyncs it before any
// signal is attempted, so cancellation is ordered even when the bridge is
// already dead, kill() fails, or no live child handle exists at all. The
// supervisor polls it immediately before creating the release gate and on
// every monitoring iteration; the parked worker gate checks it once after
// release. Readers require a regular file, so the write is
// tmp + fsync + rename + directory fsync (atomic appearance, durable
// contents) with 0600 inside the 0700 run dir.
import { closeSync, fsyncSync, lstatSync, openSync, promises as fsp, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const OWNED_LAUNCH_CANCEL_MARKER = "cancel";
const CANCEL_MARKER_CONTENT = "stage=stop\n";

let tempCounter = 0;

/**
 * Atomically write the durable cancel marker (tmp + fsync + rename + dir
 * fsync). Idempotent: an existing marker is replaced wholesale. Throws on
 * I/O failure — callers decide how loud to be about an unwritable run dir.
 */
export function writeOwnedLaunchCancelMarker(runDir: string): string {
	const path = join(runDir, OWNED_LAUNCH_CANCEL_MARKER);
	const tmp = join(runDir, `.cancel.tmp.${process.pid}.${Date.now()}.${tempCounter++}`);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, CANCEL_MARKER_CONTENT);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* best effort: the wx flag keeps tmp private to this attempt */
		}
		throw error;
	}
	const dirFd = openSync(runDir, "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
	return path;
}

/**
 * Legacy marker from the rejected age-based recovery path. It is never
 * written any more and never counts as proof (classified pending).
 */
export const OWNED_NEVER_LAUNCHED_MARKER = "never_launched";

/**
 * Exclusive launch claim (restart fencing). Exactly one of the bridge
 * (`role=bridge-claim`, native `claim_run`) and parent restart recovery
 * (`role=fence`) can ever publish this file: each writes its complete record
 * to a private temp file and publishes it with link(2), which refuses an
 * existing target. The bridge claims before binding any listener or running
 * any launchctl action and exits on EEXIST, so a fenced run provably never
 * bootstrapped a supervisor and never released a payload.
 */
export const OWNED_LAUNCH_CLAIM_FILE = "claim";
/** Published with the spec: only runs declaring it are fenceable (older bridges never claim). */
export const OWNED_LAUNCH_CLAIM_PROTOCOL_FILE = "claim_protocol";
export const OWNED_LAUNCH_CLAIM_PROTOCOL_CONTENT = "claim_protocol=1\n";
const FENCE_CONTENT = "role=fence stage=restart-recovery\n";
const CLAIM_MAX_BYTES = 256;

export type OwnedLaunchClaim = "none" | "fence" | "bridge" | "invalid";

export function readOwnedLaunchClaimSync(runDir: string): OwnedLaunchClaim {
	let text: string;
	try {
		const file = join(runDir, OWNED_LAUNCH_CLAIM_FILE);
		const st = lstatSync(file);
		if (!st.isFile() || st.size > CLAIM_MAX_BYTES) return "invalid";
		text = readFileSync(file, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "invalid";
	}
	if (text === FENCE_CONTENT) return "fence";
	if (/^role=bridge-claim pid=[1-9]\d*\n$/.test(text)) return "bridge";
	return "invalid";
}

export function ownedLaunchClaimProtocolSync(runDir: string): boolean {
	try {
		return readFileSync(join(runDir, OWNED_LAUNCH_CLAIM_PROTOCOL_FILE), "utf8") === OWNED_LAUNCH_CLAIM_PROTOCOL_CONTENT;
	} catch {
		return false;
	}
}

/**
 * Try to fence an unclaimed run so no bridge can ever start it. Returns the
 * claim that owns the run afterwards: "fence" when recovery holds it (now or
 * from an earlier, possibly interrupted attempt), "bridge" when a bridge won
 * the race, otherwise "none"/"invalid" (I/O failure: stays unfenced, retried).
 * Asynchronous: never blocks the caller's event loop on fsync.
 */
export async function fenceOwnedLaunchRunAsync(runDir: string): Promise<OwnedLaunchClaim> {
	const claim = join(runDir, OWNED_LAUNCH_CLAIM_FILE);
	const tmp = join(runDir, `.claim.fence.${process.pid}.${Date.now()}.${tempCounter++}`);
	try {
		const handle = await fsp.open(tmp, "wx", 0o600);
		try {
			await handle.writeFile(FENCE_CONTENT);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fsp.link(tmp, claim);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const dir = await fsp.open(runDir, "r");
		try {
			await dir.sync();
		} finally {
			await dir.close();
		}
	} catch {
		/* fall through: report whatever claim durably exists */
	} finally {
		await fsp.unlink(tmp).catch(() => {});
	}
	return readOwnedLaunchClaimSync(runDir);
}
