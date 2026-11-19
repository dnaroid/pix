import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { SupervisorMandate, SupervisorRegistry } from "./supervisor-store.js";

export const SUPERVISOR_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

interface BudgetSnapshot {
	budgetTokens?: number;
	budgetUsedTokens?: number;
	budgetHeld?: true;
}

interface BudgetDeps {
	now?: () => number;
	usage(cwd: string, ids: ReadonlyMap<string, number>, now: number): Promise<number>;
	readHold?(cwd: string): Promise<string | undefined>;
	writeHold?(cwd: string, id: string | undefined): Promise<void>;
	report?(error: unknown): void;
	escalate(cwd: string, detail: { limit: number; used: number | null }): Promise<void>;
}

/** The hold belongs to the supervisor, not a worker. Only an explicit user
 * action can release it; reads, window expiry and worker events cannot. */
export function createSupervisorBudget(deps: BudgetDeps) {
	const now = deps.now ?? Date.now;
	const holds = new Map<string, string>();
	let disposed = false;
	async function held(cwd: string, registry: SupervisorRegistry): Promise<boolean> {
		const matches = (id: string | undefined) => id !== undefined
			&& (id === registry.supervisorSessionId || Object.hasOwn(registry.previousSupervisors ?? {}, id));
		return matches(holds.get(resolve(cwd))) || matches(await deps.readHold?.(cwd));
	}

	function usage(cwd: string, registry: SupervisorRegistry): Promise<number | undefined> {
		const time = now();
		const ids = new Map(Object.entries(registry.previousSupervisors ?? {}).filter(([, retiredAt]) => retiredAt >= time - SUPERVISOR_BUDGET_WINDOW_MS));
		if (registry.supervisorSessionId) ids.set(registry.supervisorSessionId, time);
		for (const [id, entry] of Object.entries(registry.sessions)) if (entry.mode === "managed") ids.set(id, time);
		return deps.usage(cwd, ids, time).catch(() => undefined);
	}

	async function status(cwd: string, mandate: SupervisorMandate, registry: SupervisorRegistry): Promise<BudgetSnapshot> {
		const budgetTokens = mandate.budgetTokens;
		if (budgetTokens === undefined) return {};
		const budgetUsedTokens = await usage(cwd, registry);
		return { budgetTokens, ...(budgetUsedTokens === undefined ? {} : { budgetUsedTokens }),
			...(registry.supervisorSessionId && await held(cwd, registry) ? { budgetHeld: true } : {}) };
	}

	function available(snapshot: BudgetSnapshot): boolean {
		return snapshot.budgetTokens === undefined
			|| (snapshot.budgetUsedTokens !== undefined && snapshot.budgetUsedTokens < snapshot.budgetTokens);
	}

	return {
		status,
		async blocks(cwd: string, mandate: SupervisorMandate, registry: SupervisorRegistry): Promise<boolean> {
			if (disposed) return true;
			const { budgetTokens: limit } = mandate;
			const id = registry.supervisorSessionId;
			if (limit === undefined || !id) return false;
			const key = resolve(cwd);
			if (await held(cwd, registry) || disposed) return true;
			const used = await usage(cwd, registry);
			if (disposed) return true;
			if (used !== undefined && used < limit) return false;
			holds.set(key, id);
			await deps.writeHold?.(cwd, id).catch(deps.report ?? (() => {}));
			await deps.escalate(cwd, { limit, used: used ?? null }).catch(deps.report ?? (() => {}));
			return true;
		},
		/** Only call with a user patch, serialized with digest delivery. */
		async mandateChanged(cwd: string, previous: SupervisorMandate, mandate: SupervisorMandate,
			registry: SupervisorRegistry, resume: boolean): Promise<{ snapshot: BudgetSnapshot; retry: boolean }> {
			const raised = previous.budgetTokens !== undefined
				&& (mandate.budgetTokens === undefined || mandate.budgetTokens > previous.budgetTokens);
			const snapshot = await status(cwd, mandate, registry);
			if (disposed || !(raised || resume)) return { snapshot, retry: false };
			if (!available(snapshot)) return { snapshot, retry: resume && !mandate.paused };
			if (snapshot.budgetHeld || mandate.budgetTokens === undefined) {
				await deps.writeHold?.(cwd, undefined);
				holds.delete(resolve(cwd));
			}
			const { budgetHeld: _held, ...released } = snapshot;
			return { snapshot: released, retry: !mandate.paused };
		},
		dispose() { disposed = true; holds.clear(); },
	};
}

interface UsagePoint { at: number; tokens: number; key?: string }
interface CachedTail {
	ino: number;
	dev: number;
	size: number;
	mtimeMs: number;
	offset: number;
	anchor: Buffer;
	points: UsagePoint[];
}

/** Read each transcript once, then parse only appended complete lines. Store
 * rolling usage points, not transcript text. Calls for a project are serialized
 * by the supervisor lock. */
export function createSupervisorBudgetUsage(pathsFor: (cwd: string, ids: ReadonlyMap<string, number>) => Promise<readonly (readonly [path: string, until: number])[]>) {
	const projects = new Map<string, Map<string, CachedTail>>();
	const lifetime = new AbortController();
	return {
		async usage(cwd: string, ids: ReadonlyMap<string, number>, now: number): Promise<number> {
			const key = resolve(cwd);
			const paths = new Map<string, number>();
			for (const [path, until] of await pathsFor(key, ids)) paths.set(path, Math.max(paths.get(path) ?? 0, until));
			lifetime.signal.throwIfAborted();
			const cache = projects.get(key) ?? new Map<string, CachedTail>();
			projects.set(key, cache);
			for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
			const cutoff = now - SUPERVISOR_BUDGET_WINDOW_MS;
			const seen = new Set<string>();
			let used = 0;
			for (const [path, until] of paths) {
				lifetime.signal.throwIfAborted();
				const tail = await readTail(path, cache.get(path), cutoff, lifetime.signal);
				if (!tail) { cache.delete(path); continue; }
				cache.set(path, tail);
				for (const point of tail.points) {
					if (point.at > Math.min(now, until) || (point.key && seen.has(point.key))) continue;
					if (point.key) seen.add(point.key);
					used = Math.min(Number.MAX_SAFE_INTEGER, used + point.tokens);
				}
			}
			return used;
		},
		dispose() { lifetime.abort(); projects.clear(); },
	};
}

async function readTail(path: string, cached: CachedTail | undefined, cutoff: number, signal: AbortSignal): Promise<CachedTail | undefined> {
	const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined; // A new session may not have its first assistant message yet.
	});
	if (!file) return undefined;
	try {
		const { ino, dev, size, mtimeMs } = await file.stat();
		const sameFile = cached && cached.ino === ino && cached.dev === dev;
		if (sameFile && cached.size === size && cached.mtimeMs === mtimeMs) {
			cached.points = cached.points.filter((point) => point.at >= cutoff);
			return cached;
		}
		const anchorAt = async (offset: number) => {
			const anchor = Buffer.alloc(Math.min(64, offset));
			const { bytesRead } = await file.read(anchor, 0, anchor.length, offset - anchor.length);
			return anchor.subarray(0, bytesRead);
		};
		const base = sameFile && size > cached.size && (await anchorAt(cached.offset)).equals(cached.anchor) ? cached : undefined;
		const points = base?.points.filter((point) => point.at >= cutoff) ?? [];
		const buffer = Buffer.allocUnsafe(128 * 1024);
		let offset = base?.offset ?? 0;
		let fragments: Buffer[] = [];
		let pendingBytes = 0;
		while (offset < size) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
			const chunk = buffer.subarray(0, bytesRead);
			let start = 0;
			for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
				const part = chunk.subarray(start, end);
				const point = parseUsage(fragments.length ? Buffer.concat([...fragments, part]) : part, cutoff);
				if (point) points.push(point);
				fragments = [];
				pendingBytes = 0;
				start = end + 1;
			}
			if (start < bytesRead) {
				fragments.push(Buffer.from(chunk.subarray(start)));
				pendingBytes += bytesRead - start;
			}
		}
		offset -= pendingBytes;
		return { ino, dev, size, mtimeMs, offset, anchor: await anchorAt(offset), points };
	} finally {
		await file.close();
	}
}

function parseUsage(line: Buffer, cutoff: number): UsagePoint | undefined {
	try {
		const entry = JSON.parse(line.toString("utf8"));
		if (entry?.type !== "message" || entry.message?.role !== "assistant") return undefined;
		const timestamp = entry.message.timestamp;
		const at = typeof timestamp === "number" ? timestamp : Date.parse(entry.timestamp);
		const tokens = entry.message.usage?.totalTokens;
		if (!Number.isFinite(at) || at < cutoff || !Number.isSafeInteger(tokens) || tokens <= 0) return undefined;
		return { at, tokens, ...(typeof entry.id === "string" ? { key: `${entry.id}:${at}` } : {}) };
	} catch {
		return undefined; // A malformed line is not an assistant usage record.
	}
}
