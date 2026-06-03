import { Toast, type ToastKind, type ToastVariant } from "../../ui.js";
import { TOAST_DURATION_MS } from "../constants.js";

export type AppToastControllerHost = {
	requestRender(reason: string): void;
};

export class AppToastController {
	readonly toast = new Toast();

	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

	constructor(private readonly host: AppToastControllerHost) {}

	showToast(message: string, kind: ToastKind = "info", options: { durationMs?: number; variant?: ToastVariant } = {}): void {
		const toastId = this.toast.show(message, kind, options.variant ? { variant: options.variant } : {});
		if (kind === "error" || options.variant === "dialog") {
			this.host.requestRender("rendering:toast-controller");
			return;
		}
		const durationMs = typeof options.durationMs === "number" && Number.isFinite(options.durationMs) && options.durationMs > 0
			? Math.floor(options.durationMs)
			: TOAST_DURATION_MS;

		const timer = setTimeout(() => {
			this.toast.hide(toastId);
			this.timers.delete(toastId);
			this.host.requestRender("rendering:toast-controller");
		}, durationMs);
		this.timers.set(toastId, timer);
		timer.unref();
		this.host.requestRender("rendering:toast-controller");
	}

	dismissToast(toastId: number): void {
		const timer = this.timers.get(toastId);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(toastId);
		}
		this.toast.hide(toastId);
		this.host.requestRender("rendering:toast-controller");
	}

	clearToastTimers(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.toast.hide();
	}
}
