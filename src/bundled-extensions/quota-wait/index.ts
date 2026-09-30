import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isQuotaCandidate, isQuotaExhaustion, parseQuotaWait, quotaFromError, QuotaWaitController, type QuotaCheck, type QuotaWaitState } from "../../app/session/quota-wait.js";
import { checkQuota } from "./usage.js";
import { QuotaWaitPopup } from "./popup.js";

const ENTRY = "pix-quota-wait";
const CHANNEL = "pix:quota-wait";

export default function quotaWait(pi: ExtensionAPI, query = checkQuota): void {
	let controller: QuotaWaitController | undefined;
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let epoch = 0;
	let pending: { reason: string; check: QuotaCheck } | undefined;
	let lastPersisted = "";
	const popup = new QuotaWaitPopup();
	const publish = (state: QuotaWaitState | undefined): void => {
		const ctx = context;
		if (!ctx) return;
		const data = { state: state ?? null };
		// Persist transitions, not the one-second countdown repaint.
		const serialized = JSON.stringify(data);
		if (serialized !== lastPersisted) { pi.appendEntry(ENTRY, data); lastPersisted = serialized; }
		pi.events.emit(CHANNEL, { sessionId: ctx.sessionManager.getSessionId(), ...data });
		if (ctx.mode === "rpc") ctx.ui.setWidget("pix.session-state", ["quota-wait", serialized]);
		popup.update(ctx, state);
	};
	const action = (value: string): void => {
		if (value === "retry") void controller?.check(true);
		if (value === "cancel") controller?.cancel();
	};
	const show = (): void => {
		if (context && controller?.state) void popup.show(context, controller.state, action).catch(() => {});
	};
	const teardown = (): void => {
		epoch++;
		if (timer) clearInterval(timer);
		timer = undefined;
		controller?.dispose();
		controller = undefined;
		popup.close();
		pending = undefined;
		context = undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		teardown();
		context = ctx;
		lastPersisted = "";
		const owner = epoch;
		controller = new QuotaWaitController({
			now: Date.now,
			check: () => query(context?.model, context?.thinkingLevel),
			canResume: () => epoch === owner && !!context?.isIdle() && !!context.model
				&& `${context.model.provider}/${context.model.id}` === controller?.state?.modelKey,
			resume: () => pi.sendMessage({ customType: "pix-quota-resume", content: "Continue the previous task from where you stopped.", display: false }, { triggerTurn: true }),
			changed: publish,
		});
		// The active branch, not all JSONL entries (which can include abandoned forks).
		const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === ENTRY);
		const saved = entry?.type === "custom" ? parseQuotaWait((entry.data as { state?: unknown } | undefined)?.state) : undefined;
		if (saved && ctx.model && saved.modelKey === `${ctx.model.provider}/${ctx.model.id}`) {
			controller.restore(saved);
			show();
		} else publish(undefined);
		timer = setInterval(() => {
			controller?.tick();
			if (context) popup.update(context, controller?.state);
		}, 1000);
		timer.unref?.();
	});
	pi.on("session_shutdown", teardown);
	pi.on("model_select", (_event, ctx) => { context = ctx; pending = undefined; controller?.clear(); });
	pi.on("input", (_event, ctx) => {
		context = ctx;
		// A new explicit user task supersedes the failed task, but our hidden resume does not use input.
		if (controller?.state) controller.clear();
	});
	pi.on("message_end", (event) => {
		if (controller?.state?.phase === "resuming" && event.message.role === "assistant"
			&& event.message.stopReason !== "error" && event.message.stopReason !== "aborted") controller.clear();
	});
	pi.on("agent_end", async (event, ctx) => {
		context = ctx;
		const owner = epoch;
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (!last || last.role !== "assistant" || last.stopReason !== "error" || !last.errorMessage) {
			if (controller?.state?.phase === "resuming") controller.clear();
			return;
		}
		const explicit = isQuotaExhaustion(last.errorMessage);
		if (!isQuotaCandidate(last.errorMessage)) {
			if (controller?.state?.phase === "resuming") controller.clear();
			return;
		}
		const signal = ctx.signal;
		if (signal?.aborted) return;
		const check = await query(ctx.model, ctx.thinkingLevel);
		if (owner !== epoch || signal?.aborted) return;
		if (!explicit && check.kind !== "exhausted") {
			if (controller?.state?.phase === "resuming") controller.clear();
			return;
		}
		pending = { reason: last.errorMessage, check: check.kind === "exhausted" ? check : quotaFromError(last.errorMessage, Date.now()) };
		// This is after the tool batch; prevent the SDK's short transient retry loop.
		ctx.abort();
		if (ctx.model) controller?.wait(`${ctx.model.provider}/${ctx.model.id}`, pending.reason, pending.check);
	});
	pi.on("agent_settled", (_event, ctx) => {
		context = ctx;
		if (pending) { pending = undefined; show(); }
	});
	pi.registerCommand("quota-wait", {
		description: "Quota wait: show, retry now, cancel auto-resume, or inspect state",
		handler: async (args, ctx) => {
			context = ctx;
			const command = args.trim();
			if (command === "state") publish(controller?.state);
			else if (command === "retry" || command === "cancel") action(command);
			else if (controller?.state) show();
			else ctx.ui.notify("This session is not waiting for quota", "info");
		},
	});
}
