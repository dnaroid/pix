import { Toast, type ToastEntry, type ToastKind, type ToastVariant } from "../../ui.js";
import { TOAST_DURATION_MS } from "../constants.js";

export type AppToastEntry = ToastEntry & {
	action?: { label: string };
	actions?: readonly { label: string }[];
	scrollOffset?: number;
};

export type AppToastAction = {
	label: string;
	onSelect: () => void;
};

export type AppToastOptions = {
	durationMs?: number;
	variant?: ToastVariant;
	scopeKey?: string;
	action?: AppToastAction;
	actions?: readonly AppToastAction[];
};

export type AppToastControllerHost = {
	activeScope?(): string | undefined;
	render(): void;
};

export class AppToastController {
	private readonly toastsByScope = new Map<string, Toast>();
	private readonly timers = new Map<string, Map<number, ReturnType<typeof setTimeout>>>();
	private readonly actions = new Map<string, Map<number, readonly AppToastAction[]>>();
	private readonly scrollOffsets = new Map<string, Map<number, number>>();

	constructor(private readonly host: AppToastControllerHost) {}

	showToast(message: string, kind: ToastKind = "info", options: AppToastOptions = {}): number {
		const scopeKey = this.normalizeScopeKey(options.scopeKey ?? this.host.activeScope?.());
		const toast = this.toastForScope(scopeKey);
		const actions = options.actions ?? (options.action ? [options.action] : []);
		const toastId = toast.show(message, kind, options.variant ? { variant: options.variant } : {});
		if (actions.length) this.actionsForScope(scopeKey).set(toastId, actions);
		if (kind === "error" || options.variant === "dialog") {
			this.host.render();
			return toastId;
		}
		const durationMs = typeof options.durationMs === "number" && Number.isFinite(options.durationMs) && options.durationMs > 0
			? Math.floor(options.durationMs)
			: TOAST_DURATION_MS;

		const timer = setTimeout(() => {
			toast.hide(toastId);
			this.timers.get(scopeKey)?.delete(toastId);
			this.removeAction(scopeKey, toastId);
			this.deleteScopeIfEmpty(scopeKey);
			this.host.render();
		}, durationMs);
		this.timersForScope(scopeKey).set(toastId, timer);
		timer.unref();
		this.host.render();
		return toastId;
	}

	dismissToast(toastId: number, scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): void {
		const timers = this.timers.get(scopeKey);
		const timer = timers?.get(toastId);
		if (timer) {
			clearTimeout(timer);
			timers?.delete(toastId);
		}
		this.toastsByScope.get(scopeKey)?.hide(toastId);
		const scrolls = this.scrollOffsets.get(scopeKey);
		scrolls?.delete(toastId);
		if (scrolls?.size === 0) this.scrollOffsets.delete(scopeKey);
		this.removeAction(scopeKey, toastId);
		this.deleteScopeIfEmpty(scopeKey);
		this.host.render();
	}

	activateAction(toastId: number, index = 0, scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): boolean {
		const action = this.actions.get(scopeKey)?.get(toastId)?.[index];
		if (!action) return false;

		this.dismissToast(toastId, scopeKey);
		action.onSelect();
		return true;
	}

	scrollDialog(toastId: number, delta: number, scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): boolean {
		const state = this.toastsByScope.get(scopeKey)?.entry(toastId);
		if (state?.variant !== "dialog") return false;
		let offsets = this.scrollOffsets.get(scopeKey);
		if (!offsets) {
			offsets = new Map();
			this.scrollOffsets.set(scopeKey, offsets);
		}
		offsets.set(toastId, Math.max(0, (offsets.get(toastId) ?? 0) + delta));
		this.host.render();
		return true;
	}

	scrollActiveDialog(delta: number): boolean {
		const active = [...this.visibleStates()].reverse().find((toast) => toast.variant === "dialog");
		return active ? this.scrollDialog(active.id, delta) : false;
	}

	dismissActiveDialog(scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): boolean {
		const states = this.visibleStates(scopeKey);
		let dialog: ToastEntry | undefined;
		for (let index = states.length - 1; index >= 0; index -= 1) {
			const toast = states[index];
			if (!toast) continue;
			if (toast.variant !== "dialog") continue;
			dialog = toast;
			break;
		}
		if (!dialog) return false;

		this.dismissToast(dialog.id, scopeKey);
		return true;
	}

	visibleStates(scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): readonly AppToastEntry[] {
		const states = this.toastsByScope.get(scopeKey)?.visibleStates ?? [];
		const actions = this.actions.get(scopeKey);
		const offsets = this.scrollOffsets.get(scopeKey);
		if ((!actions || actions.size === 0) && (!offsets || offsets.size === 0)) return states;
		return states.map((state) => {
			const choices = actions?.get(state.id);
			const scrollOffset = offsets?.get(state.id);
			return {
				...state,
				...(choices ? { action: { label: choices[0]!.label }, actions: choices.map(({ label }) => ({ label })) } : {}),
				...(scrollOffset === undefined ? {} : { scrollOffset }),
			};
		});
	}

	entry(toastId: number, scopeKey = this.normalizeScopeKey(this.host.activeScope?.())): ToastEntry | undefined {
		return this.toastsByScope.get(scopeKey)?.entry(toastId);
	}

	clearToastTimers(): void {
		for (const timers of this.timers.values()) {
			for (const timer of timers.values()) clearTimeout(timer);
		}
		this.timers.clear();
		this.actions.clear();
		this.scrollOffsets.clear();
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

	private actionsForScope(scopeKey: string): Map<number, readonly AppToastAction[]> {
		let actions = this.actions.get(scopeKey);
		if (!actions) {
			actions = new Map<number, readonly AppToastAction[]>();
			this.actions.set(scopeKey, actions);
		}
		return actions;
	}

	private removeAction(scopeKey: string, toastId: number): void {
		const actions = this.actions.get(scopeKey);
		actions?.delete(toastId);
		if (actions?.size === 0) this.actions.delete(scopeKey);
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
