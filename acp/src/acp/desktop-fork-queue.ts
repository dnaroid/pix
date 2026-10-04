import type { DesktopQueueItem, DesktopQueuedForkMessage, DesktopQueuedUserMessage } from "./desktop-commands.js";
import type { DesktopForkChild, DesktopForkSnapshot } from "./desktop-fork-snapshot.js";

interface ForkQueueHost {
	isLive(): boolean;
	captureIdle(): Promise<DesktopForkSnapshot | undefined>;
	create(snapshot: DesktopForkSnapshot): Promise<DesktopForkChild>;
	saveChild(child: DesktopForkChild, message: DesktopQueuedUserMessage): Promise<void>;
	announce(child: DesktopForkChild): Promise<void>;
	cleanup(child: DesktopForkChild): Promise<void>;
	persist(): Promise<void>;
	changed(): Promise<void>;
	report(error: unknown): void;
}

/** Pending fork work is never submitted to the source SDK queue or prompt API. */
export class DesktopForkQueue {
	messages: DesktopQueuedForkMessage[] = [];
	private readonly jobs = new Map<string, Promise<void>>();
	private readonly admitting = new Set<string>();
	private readonly admissionCaptures = new Set<Promise<unknown>>();
	private readonly mutations = new Set<Promise<unknown>>();
	private closed = false;
	private boundaryRevision = 0;
	private idleCapture: Promise<void> | undefined;

	constructor(private readonly host: ForkQueueHost) {}

	load(messages: readonly DesktopQueuedForkMessage[]): void {
		this.boundaryRevision++;
		this.messages = messages.map(clone);
	}

	admit(message: DesktopQueuedUserMessage): Promise<void> {
		return this.trackMutation(this.admitMessage(message));
	}

	private async admitMessage(message: DesktopQueuedUserMessage): Promise<void> {
		if (!this.live()) throw new Error("source session closed");
		const admitted = clone(message);
		this.messages.push(admitted);
		this.admitting.add(admitted.id);
		// Begin the idle snapshot before disk persistence/notification can delay
		// admission. Once captured, a later source turn must not move its leaf.
		const revision = this.boundaryRevision;
		const idle = this.host.captureIdle().then(
			(snapshot) => ({ snapshot: revision === this.boundaryRevision ? snapshot : undefined }),
			(error: unknown) => ({ error }),
		);
		this.admissionCaptures.add(idle);
		void idle.finally(() => this.admissionCaptures.delete(idle));
		try {
			await this.host.persist();
		} catch (error) {
			this.messages = this.messages.filter((item) => item !== admitted);
			throw error;
		} finally {
			this.admitting.delete(admitted.id);
		}
		await this.host.changed();
		const completion = idle.then(async (result) => {
			if (!this.current(admitted) || this.jobs.has(admitted.id)) return;
			if ("error" in result) {
				this.fail(admitted, result.error);
				await this.host.persist().catch(this.host.report);
				await this.host.changed();
			} else if (result.snapshot) {
				this.start(admitted, result.snapshot);
			} else {
				await this.tryIdle();
			}
		}).catch(this.host.report);
		this.admissionCaptures.add(completion);
		void completion.finally(() => this.admissionCaptures.delete(completion));
	}

	take(index: number, text: string): Promise<DesktopQueuedUserMessage | undefined> {
		return this.trackMutation(this.takeMessage(index, text));
	}

	private async takeMessage(index: number, text: string): Promise<DesktopQueuedUserMessage | undefined> {
		if (!this.live()) throw new Error("source session closed");
		const message = this.messages[index];
		if (!message || message.displayText !== text) return undefined;
		this.messages.splice(index, 1);
		try {
			await this.host.persist();
		} catch (error) {
			this.messages.splice(Math.min(index, this.messages.length), 0, message);
			// Creation may already have observed the temporary removal and cleaned
			// its child. Expose a recoverable failure rather than strand a pending
			// item waiting for a boundary that an idle source may never produce.
			this.fail(message, error);
			await this.host.persist().catch(this.host.report);
			await this.host.changed();
			throw error;
		}
		return clone(message);
	}

	items(): DesktopQueueItem[] {
		return this.messages.map((message, index) => ({
			id: `fork:${message.id}`, source: "fork", mode: "fork", index,
			text: message.displayText, message: clone(message),
			...(message.error !== undefined ? { error: message.error } : {}),
		}));
	}

	/** Called synchronously by the RPC event handler, before any async child work. */
	boundary(snapshot: DesktopForkSnapshot): void {
		this.boundaryRevision++;
		if (!this.live()) return;
		for (const message of [...this.messages]) {
			if (message.error !== undefined || this.jobs.has(message.id) || this.admitting.has(message.id)) continue;
			this.start(message, snapshot);
		}
	}

	private start(message: DesktopQueuedForkMessage, snapshot: DesktopForkSnapshot): void {
		const job = this.run(message, { ...snapshot });
		this.jobs.set(message.id, job);
		void job.finally(() => this.jobs.delete(message.id)).catch(this.host.report);
	}

	tryIdle(): Promise<void> {
		if (this.idleCapture) return this.idleCapture;
		if (!this.live() || !this.messages.some((item) => item.error === undefined && !this.jobs.has(item.id) && !this.admitting.has(item.id))) return Promise.resolve();
		const revision = this.boundaryRevision;
		const capture = (async () => {
			try {
				const snapshot = await this.host.captureIdle();
				if (snapshot && this.live() && revision === this.boundaryRevision) this.boundary(snapshot);
			} catch (error) {
				if (!this.live() || revision !== this.boundaryRevision) return;
				for (const message of this.messages) {
					if (!this.jobs.has(message.id) && message.error === undefined) this.fail(message, error);
				}
				await this.host.persist().catch(this.host.report);
				await this.host.changed();
			} finally {
				this.idleCapture = undefined;
				if (this.live() && revision !== this.boundaryRevision) queueMicrotask(() => void this.tryIdle());
			}
		})();
		this.idleCapture = capture;
		return capture;
	}

	/** Invalidates first; completion is joined by adapter disposal, never allowed to announce. */
	close(): void { this.closed = true; this.boundaryRevision++; }
	async settled(): Promise<void> {
		await Promise.allSettled(this.mutations);
		await Promise.all(this.admissionCaptures);
		await this.idleCapture;
		await Promise.all(this.jobs.values());
	}
	private trackMutation<T>(operation: Promise<T>): Promise<T> {
		this.mutations.add(operation);
		void operation.finally(() => this.mutations.delete(operation)).catch(() => {});
		return operation;
	}
	private live(): boolean { return !this.closed && this.host.isLive(); }
	private current(message: DesktopQueuedForkMessage): boolean { return this.live() && this.messages.includes(message); }

	private fail(message: DesktopQueuedForkMessage, error: unknown): void {
		const index = this.messages.indexOf(message);
		if (index >= 0) this.messages[index] = { ...message, error: error instanceof Error ? error.message : String(error) };
		this.host.report(error);
	}

	private async run(message: DesktopQueuedForkMessage, snapshot: DesktopForkSnapshot): Promise<void> {
		let child: DesktopForkChild | undefined;
		let removed = false;
		try {
			child = await this.host.create(snapshot);
			if (!this.current(message)) return;
			await this.host.saveChild(child, clone(message));
			if (!this.current(message)) return;
			// Source item stays editable/cancelable throughout creation and child persistence.
			this.messages.splice(this.messages.indexOf(message), 1);
			removed = true;
			await this.host.persist();
			if (!this.live()) return;
			await this.host.announce(child);
			child = undefined; // Desktop now owns the independently persisted child.
			await this.host.changed();
		} catch (error) {
			if (removed) { this.messages.push(message); removed = false; }
			if (this.current(message)) {
				this.fail(message, error);
				await this.host.persist().catch(this.host.report);
				await this.host.changed();
			}
		} finally {
			// Teardown can win while source consumption is being persisted. Put it
			// back durably even though no live runtime remains to report the state.
			if (child && removed) {
				this.messages.push(message);
				await this.host.persist().catch(this.host.report);
			}
			if (child) await this.host.cleanup(child).catch(this.host.report);
		}
	}
}

function clone<T extends DesktopQueuedUserMessage>(message: T): T {
	return { ...message, images: message.images.map((image) => ({ ...image })) };
}
