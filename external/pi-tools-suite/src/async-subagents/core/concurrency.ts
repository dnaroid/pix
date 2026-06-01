/**
 * Simple concurrency limiter (semaphore) for spawn batches.
 *
 * Usage:
 *   const sem = createSemaphore(5);
 *   // Before spawning:
 *   await sem.acquire(signal);
 *   // After agent completes:
 *   sem.release();
 */

export interface Semaphore {
	/** Wait until a slot is available. Rejects if signal is aborted. */
	acquire(signal?: AbortSignal): Promise<void>;
	/** Release a slot, allowing the next queued acquire to proceed. */
	release(): void;
	/** Current number of slots in use. */
	readonly active: number;
	/** Number of waiters in the queue. */
	readonly waiting: number;
	/** Maximum concurrency (0 = unlimited). */
	readonly limit: number;
}

interface Waiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

/**
 * Create a concurrency semaphore.
 * @param limit - Maximum concurrent holders. 0 or negative means unlimited (acquire never blocks).
 */
export function createSemaphore(limit: number): Semaphore {
	const effectiveLimit = limit > 0 ? limit : 0;
	let active = 0;
	const queue: Waiter[] = [];

	function acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("Aborted"));
		// Unlimited: never block.
		if (effectiveLimit === 0) {
			active++;
			return Promise.resolve();
		}
		if (active < effectiveLimit) {
			active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject };
			queue.push(waiter);

			if (signal) {
				const onAbort = () => {
					const idx = queue.indexOf(waiter);
					if (idx !== -1) {
						queue.splice(idx, 1);
						reject(new Error("Aborted"));
					}
				};
				signal.addEventListener("abort", onAbort, { once: true });
				// Clean up listener when waiter is resolved normally.
				const origResolve = waiter.resolve;
				waiter.resolve = () => {
					signal.removeEventListener("abort", onAbort);
					origResolve();
				};
			}
		});
	}

	function release(): void {
		if (active <= 0) return;
		active--;
		if (queue.length > 0 && (effectiveLimit === 0 || active < effectiveLimit)) {
			active++;
			const next = queue.shift()!;
			next.resolve();
		}
	}

	return {
		acquire,
		release,
		get active() { return active; },
		get waiting() { return queue.length; },
		get limit() { return effectiveLimit; },
	};
}
