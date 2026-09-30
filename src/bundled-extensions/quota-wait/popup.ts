import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PixExtensionUIContext, PixMenuOptions } from "../../app/types.js";
import type { QuotaWaitState } from "../../app/session/quota-wait.js";

export function quotaWaitLabel(state: QuotaWaitState, now = Date.now()): string {
	if (!state.autoResume) return "Quota wait · auto-resume cancelled";
	if (state.phase === "checking") return "Quota wait · checking availability…";
	if (state.phase === "resuming") return "Quota wait · trying to continue…";
	const seconds = Math.max(0, Math.ceil((state.nextCheckAt - now) / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	const s = seconds % 60;
	return `${state.window === "unknown" ? "Usage" : state.window === "weekly" ? "Weekly" : "Hourly"} limit · ${state.resetAt ? "reset check" : "next check"} in ${h ? `${h}h ` : ""}${m}m ${s}s`;
}

/** Uses Pix's scoped native menu: switching tabs dismisses, never cancels the wait. */
export class QuotaWaitPopup {
	private options: PixMenuOptions | undefined;
	private ctx: ExtensionContext | undefined;
	update(ctx: ExtensionContext, state: QuotaWaitState | undefined): void {
		this.ctx = ctx;
		if (this.options && !state) this.close();
		if (this.options && state) this.options.title = quotaWaitLabel(state);
		ctx.ui.setStatus("quota-wait", state ? `${quotaWaitLabel(state)} · /quota-wait` : undefined);
	}
	async show(ctx: ExtensionContext, state: QuotaWaitState, action: (value: string) => void): Promise<void> {
		if (this.options || ctx.mode !== "tui" || !ctx.hasUI) return;
		const ui = ctx.ui as PixExtensionUIContext;
		if (!ui.showMenu) return;
		const options: PixMenuOptions = { title: quotaWaitLabel(state), placement: "center", searchable: false, preserveStatus: true };
		this.options = options;
		this.ctx = ctx;
		try {
			const choice = await ui.showMenu([
				{ value: "retry", label: "Try now", description: "Probe continuation even if the limit has not reset" },
				{ value: "cancel", label: "Cancel auto-resume", description: "Keep this task paused" },
				{ value: "hide", label: "Hide", description: "Continue waiting in the background" },
			], options);
			if (choice) action(choice);
		} finally { if (this.options === options) this.options = undefined; }
	}
	close(): void {
		if (!this.options) return;
		this.options = undefined;
		(this.ctx?.ui as PixExtensionUIContext | undefined)?.menu?.close();
	}
}
