import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { registryUiCacheRoot } from "./config.js";

const queues = new Map<string, Promise<void>>();

/** Own the checkout and provenance through the entire operation, including reads. */
export async function withRegistryCache<T>(task: () => Promise<T>): Promise<T> {
	const key = registryUiCacheRoot();
	const previous = queues.get(key) ?? Promise.resolve();
	let releaseTurn!: () => void;
	const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
	const tail = previous.then(() => turn);
	queues.set(key, tail);
	await previous;
	try {
		await fs.mkdir(dirname(key), { recursive: true });
		// The sibling lock survives checkout deletion/recreation on remote changes.
		// No target is required before the first clone. Heartbeats recover a crashed
		// owner after two minutes; a compromised lock uses the library's fail-stop
		// default rather than allowing unlocked Git mutations to continue.
		const releaseLock = await lock(key, {
			realpath: false,
			stale: 120_000,
			update: 10_000,
			retries: { retries: 600, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 },
		});
		try { return await task(); }
		finally { await releaseLock(); }
	} finally {
		releaseTurn();
		if (queues.get(key) === tail) queues.delete(key);
	}
}
