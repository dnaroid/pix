import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type QuotaWaitAction = "pause" | "continue";
type ControlData = { action: QuotaWaitAction; isCurrent(): boolean; accepted(): void; settle(result: boolean | Error): void };
const CONTROL = "pix-quota-control";

/** In-process envelope intercepted before transcript persistence, in both Pix hosts. */
export function requestQuotaWaitControl(pi: ExtensionAPI, action: QuotaWaitAction, isCurrent = () => true): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("This host does not support scheduled continuation")), 5000);
		timeout.unref?.();
		const data: ControlData = {
			action,
			isCurrent,
			accepted: () => clearTimeout(timeout),
			settle: (result) => { clearTimeout(timeout); result instanceof Error ? reject(result) : resolve(result); },
		};
		try { pi.sendMessage({ customType: CONTROL, content: "", display: false, details: data }); }
		catch (error) { clearTimeout(timeout); reject(error); }
	});
}

export function installQuotaWaitControl(session: Pick<AgentSession, "sendCustomMessage">,
	handle: (action: QuotaWaitAction, isCurrent: () => boolean) => boolean | Promise<boolean>): void {
	const original = session.sendCustomMessage;
	session.sendCustomMessage = async function (message, options) {
		if (message.customType !== CONTROL) return original.call(this, message, options);
		const data = message.details as ControlData | undefined;
		if (!data || (data.action !== "pause" && data.action !== "continue")
			|| typeof data.accepted !== "function" || typeof data.settle !== "function") return;
		data.accepted();
		try { data.settle(await handle(data.action, data.isCurrent ?? (() => true))); }
		catch (error) { data.settle(error instanceof Error ? error : new Error(String(error))); }
	};
}
