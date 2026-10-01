import { rename, writeFile } from "node:fs/promises";

export const BUILD_STATUSES = ["idle", "queued", "building", "failed"];

export function desktopWatchState(target, stale, buildStatus) {
	const state = JSON.stringify({ version: 1, target, stale: Boolean(stale), ...(buildStatus ? { buildStatus } : {}) });
	if (Buffer.byteLength(state) > 4 * 1024) throw new Error("desktop watch state exceeds its size limit");
	return `${state}\n`;
}

export async function writeDesktopWatchState(path, target, stale, buildStatus) {
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporaryPath, desktopWatchState(target, stale, buildStatus), { mode: 0o600 });
	await rename(temporaryPath, path);
}

export function parseDesktopWatchState(value) {
	if (!value || typeof value !== "object") return undefined;
	const { version, target, stale, buildStatus } = value;
	if (version !== 1 || typeof target !== "string" || typeof stale !== "boolean") return undefined;
	if (buildStatus !== undefined && !BUILD_STATUSES.includes(buildStatus)) return undefined;
	return { target, stale, ...(buildStatus ? { buildStatus } : {}) };
}

/** Serialize atomic replacements so a slow queued publication cannot overwrite a newer build state. */
export class DesktopWatchStatePublisher {
	constructor(write = writeDesktopWatchState) {
		this.write = write;
		this.state = undefined;
		this.pending = Promise.resolve();
	}

	publish(path, changes) {
		if (!path) return Promise.resolve();
		this.state = { ...this.state, ...changes };
		// There is no Desktop to notify until the first successful native artifact.
		if (!this.state.target) return Promise.resolve();
		const snapshot = { ...this.state };
		const next = this.pending.then(() => this.write(path, snapshot.target, snapshot.stale, snapshot.buildStatus));
		this.pending = next.catch(() => {});
		return next;
	}
}
