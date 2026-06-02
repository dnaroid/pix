import { Toast, type ToastKind } from "../ui.js";
import { TOAST_DURATION_MS } from "./constants.js";

export type AppToastControllerHost = {
	render(): void;
};

export class AppToastController {
	readonly toast = new Toast();

	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

	constructor(private readonly host: AppToastControllerHost) {}

	showToast(message: string, kind: ToastKind = "info", options: { durationMs?: number } = {}): void {
		const toastId = this.toast.show(message, kind);
		if (kind === "error") {
			this.host.render();
			return;
		}
		const durationMs = typeof options.durationMs === "number" && Number.isFinite(options.durationMs) && options.durationMs > 0
			? Math.floor(options.durationMs)
			: TOAST_DURATION_MS;

		const timer = setTimeout(() => {
			this.toast.hide(toastId);
			this.timers.delete(toastId);
			this.host.render();
		}, durationMs);
		this.timers.set(toastId, timer);
		timer.unref();
		this.host.render();
	}

	dismissToast(toastId: number): void {
		const timer = this.timers.get(toastId);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(toastId);
		}
		this.toast.hide(toastId);
		this.host.render();
	}

	clearToastTimers(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.toast.hide();
	}
}
