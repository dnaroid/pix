import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";
import { registryUiCacheRoot } from "./config.js";
import { REGISTRY_LOCK_RETRIES, REGISTRY_LOCK_RETRY_MS, REGISTRY_LOCK_STALE_MS, REGISTRY_LOCK_UPDATE_MS } from "./lock-timing.js";

const queues = new Map<string, Promise<void>>();

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return previous;
	signal.throwIfAborted();
	let abort!: () => void;
	try {
		await Promise.race([previous, new Promise<never>((_, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally { signal.removeEventListener("abort", abort); }
}

/**
 * Own the checkout and provenance through the entire operation, including reads.
 * An aborted signal stops waiting for the lock and is checked again once it is
 * held, so shutdown never starts new work under the lock.
 */
export async function withRegistryCache<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const key = registryUiCacheRoot();
	const previous = queues.get(key) ?? Promise.resolve();
	let releaseTurn!: () => void;
	const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
	const tail = previous.then(() => turn);
	queues.set(key, tail);
	try {
		await waitForTurn(previous, signal);
		signal?.throwIfAborted();
		await fs.mkdir(dirname(key), { recursive: true });
		const releaseLock = await acquireRegistryLock(key, signal);
		try {
			signal?.throwIfAborted();
			return await task();
		} finally { await releaseLock(); }
	} finally {
		releaseTurn();
		// A cancelled slot still links followers to its predecessor.
		void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
	}
}

/**
 * The sibling lock survives checkout deletion/recreation on remote changes.
 * No target is required before the first clone. Heartbeats recover a crashed
 * owner after the stale window; a compromised lock uses the library's
 * fail-stop default rather than allowing unlocked Git mutations to continue.
 * Retries are driven here (not by proper-lockfile) so shutdown can abort them.
 */
async function acquireRegistryLock(key: string, signal: AbortSignal | undefined): Promise<() => Promise<void>> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await lock(key, { realpath: false, stale: REGISTRY_LOCK_STALE_MS, update: REGISTRY_LOCK_UPDATE_MS });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= REGISTRY_LOCK_RETRIES) throw error;
		}
		try { await delay(REGISTRY_LOCK_RETRY_MS, undefined, signal ? { signal } : undefined); }
		catch (error) { throw signal?.aborted ? signal.reason : error; }
	}
}
