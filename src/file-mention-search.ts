import type { FileMentionMatch } from "./file-mentions.js";

/** Cancels promptly and rejects stale completions even if a transport ignores abort. */
export class FileMentionSearch {
	private key = "";
	private abort: AbortController | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(
		private readonly request: (query: string, signal: AbortSignal) => Promise<FileMentionMatch[]>,
		private readonly changed: (matches: FileMentionMatch[], loading: boolean, failed: boolean) => void,
		private readonly debounceMs = 80,
	) {}
	observe(key: string, query: string): void {
		if (key === this.key) return;
		this.dispose();
		this.key = key;
		if (!key) { this.changed([], false, false); return; }
		const controller = new AbortController();
		this.abort = controller;
		this.changed([], true, false);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void Promise.resolve().then(() => this.request(query, controller.signal)).then((matches) => {
				if (!controller.signal.aborted && this.key === key) this.changed(matches, false, false);
			}).catch(() => {
				if (!controller.signal.aborted && this.key === key) this.changed([], false, true);
			});
		}, this.debounceMs);
	}
	dispose(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.abort?.abort();
		this.abort = undefined;
		this.key = "";
	}
}
