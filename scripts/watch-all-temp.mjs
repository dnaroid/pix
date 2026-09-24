import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const WATCH_TEMP_PREFIX = "pix-watch-all-";
export const WATCH_OWNER_FILE = "watch-all-owner.json";
const LEGACY_TEMP_MIN_AGE_MS = 60 * 60 * 1_000;

/** Only reclaim a directory when neither its owner nor an app/helper using its exact root survives. */
export function canReclaimWatchDirectory(directory, ownerPid, entries, currentPid = process.pid) {
	if (ownerPid === currentPid || (ownerPid !== undefined && entries.some(({ pid }) => pid === ownerPid))) return false;
	return !entries.some(({ command }) => command.includes(`${directory}/`));
}

/** A pre-marker watcher cannot be tied to its temp root, so defer all legacy cleanup while one is live. */
export function hasOtherWatchSupervisor(entries, currentPid = process.pid) {
	return entries.some(({ pid, command }) => pid !== currentPid && /(?:^|\s)(?:\S*\/)?node(?:\s+\S+)*\s+\S*scripts\/watch-all\.mjs(?:\s|$)/u.test(command));
}

/** Inspect only direct, non-symlinked children of the canonical system temp root. */
export async function reclaimStaleWatchDirectories(root, ownDirectory, processEntries, currentProcesses, reportError = console.error) {
	const otherWatcher = hasOtherWatchSupervisor(processEntries);
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.name.startsWith(WATCH_TEMP_PREFIX) || !entry.isDirectory()) continue;
		const directory = join(root, entry.name);
		if (directory === ownDirectory) continue;
		try {
			let ownerPid;
			try {
				const owner = JSON.parse(await readFile(join(directory, WATCH_OWNER_FILE), "utf8"));
				if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
				ownerPid = owner.pid;
			} catch (error) {
				if (error?.code !== "ENOENT") continue;
				// Older watchers have no owner marker. Never collect a recently created root,
				// or one possibly belonging to another live watch:all process.
				if (otherWatcher || Date.now() - (await lstat(directory)).mtimeMs < LEGACY_TEMP_MIN_AGE_MS) continue;
			}
			// The root may have been created after the initial snapshot by a second watcher.
			// Recheck its owner and app immediately before removing anything.
			if (!canReclaimWatchDirectory(directory, ownerPid, await currentProcesses())) continue;
			await rm(directory, { recursive: true, force: true });
			console.error(`[watch:all] removed abandoned temporary bundles: ${directory}`);
		} catch (error) {
			reportError(`[watch:all] could not inspect or remove ${directory}: ${error.message}`);
		}
	}
}
