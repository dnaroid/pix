type Refresh = () => Promise<void>;
type Lane = { pending: Refresh | undefined; cancelled: boolean };
type RefreshKind = "context" | "model" | "config";

/** One active operation and one replaceable follow-up per runtime and kind. */
export class SessionRefreshScheduler {
	private readonly owners = new WeakMap<object, Map<RefreshKind, Lane>>();

	constructor(private readonly onError: (error: unknown) => void) {}

	schedule(owner: object, kind: RefreshKind, refresh: Refresh): void {
		let lanes = this.owners.get(owner);
		if (!lanes) {
			lanes = new Map();
			this.owners.set(owner, lanes);
		}
		const existing = lanes.get(kind);
		if (existing) {
			existing.pending = refresh;
			return;
		}
		const lane: Lane = { pending: refresh, cancelled: false };
		lanes.set(kind, lane);
		const ownedLanes = lanes;
		queueMicrotask(() => void this.drain(owner, kind, ownedLanes, lane));
	}

	forget(owner: object): void {
		const lanes = this.owners.get(owner);
		this.owners.delete(owner);
		for (const lane of lanes?.values() ?? []) {
			lane.cancelled = true;
			lane.pending = undefined;
		}
	}

	private async drain(owner: object, kind: RefreshKind, lanes: Map<RefreshKind, Lane>, lane: Lane): Promise<void> {
		try {
			while (!lane.cancelled && lane.pending) {
				const refresh = lane.pending;
				lane.pending = undefined;
				try {
					await refresh();
				} catch (error) {
					try { this.onError(error); } catch { /* Logging must not break queue cleanup. */ }
				}
			}
		} finally {
			if (lanes.get(kind) === lane) lanes.delete(kind);
			if (!lanes.size && this.owners.get(owner) === lanes) this.owners.delete(owner);
		}
	}
}
