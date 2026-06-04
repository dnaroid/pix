import { Toast, type ToastEntry, type ToastKind, type ToastVariant } from "../../ui.js";
import { TOAST_DURATION_MS } from "../constants.js";

export type AppToastControllerHost = {
	activeScope?(): string | undefined;
	render(): void;
};

export class AppToastController {
	private readonly toastsByScope = new Map<string, Toast>();
	private readonly timers = new Map<string, Map<number, ReturnType<typeof setTimeout>>>();

	constructor(private readonly host: AppToastControllerHost) {}

	showToast(message: string, kind: ToastKind = "info", options: { durationMs?: number; variant?: ToastVariant; scopeKey?: string } = {}): void {
		const scopeKey = this.normalizeScopeKey(options.scopeKey ?? this.host.activeScope?.());
		const toast = this.toastForScope(scopeKey);
		const toastId = toast.show(message, kind, options.variant ? { variant: options.variant } : {});
		if (kind === "error" || options.variant === "dialog") {
			this.host.render();
			return;
		}
		const durationMs = typeof options.durationMs === "number" && Number.isFinite(options.durationMs) && options.durationMs > 0
			? Math.floor(options.durationMs)
			: TOAST_DURATION_MS;

		const timer = setTimeout(() => {
			toast.hide(toastId);
			this.timers.get(scopeKey)?.delete(toastId);
			this.deleteScopeIfEmpty(scopeKey);
			this.host.render();
		}, durationMs);
		this.timersForScope(scopeKey).set(toastId, timer);
		timer.unref();
		this.host.render();
	}

	dismissToast(toastId: number, scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): void {
		const timers = this.timers.get(scopeKey);
		const timer = timers?.get(toastId);
		if (timer) {
			clearTimeout(timer);
			timers?.delete(toastId);
		}
		this.toastsByScope.get(scopeKey)?.hide(toastId);
		this.deleteScopeIfEmpty(scopeKey);
		this.host.render();
	}

	visibleStates(scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): readonly ToastEntry[] {
		return this.toastsByScope.get(scopeKey)?.visibleStates ?? [];
	}

	entry(toastId: number, scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): ToastEntry | undefined {
		return this.toastsByScope.get(scopeKey)?.entry(toastId);
	}

	clearToastTimers(): void {
		for (const timers of this.timers.values()) {
			for (const timer of timers.values()) clearTimeout(timer);
		}
		this.timers.clear();
		for (const toast of this.toastsByScope.values()) toast.hide();
		this.toastsByScope.clear();
	}

	private toastForScope(scopeKey: string): Toast {
		let toast = this.toastsByScope.get(scopeKey);
		if (!toast) {
			toast = new Toast();
			this.toastsByScope.set(scopeKey, toast);
		}
		return toast;
	}

	private timersForScope(scopeKey: string): Map<number, ReturnType<typeof setTimeout>> {
		let timers = this.timers.get(scopeKey);
		if (!timers) {
			timers = new Map();
			this.timers.set(scopeKey, timers);
		}
		return timers;
	}

	private deleteScopeIfEmpty(scopeKey: string): void {
		const timers = this.timers.get(scopeKey);
		if (timers && timers.size === 0) this.timers.delete(scopeKey);
		if (!this.toastsByScope.get(scopeKey)?.visible) this.toastsByScope.delete(scopeKey);
	}

	private normalizeScopeKey(scopeKey: string | undefined): string {
		return scopeKey ?? "";
	}
}
