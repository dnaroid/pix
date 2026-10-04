import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HeadsUpController } from "./controller.js";
import { headsUpDiscussionDraft } from "./contract.js";
import { presentHeadsUp } from "./presentation.js";
import { requestHeadsUp } from "./inference.js";
import { loadHeadsUpSettings, offline } from "./settings.js";
import { observerUsageRecorder } from "./usage.js";

export function observerRuntimeAllowed(ctx: ExtensionContext): boolean {
	return !offline() && !process.env.PI_SUBAGENT_AGENT_DIR && ctx.hasUI
		&& (ctx.mode === "tui" || (ctx.mode === "rpc" && process.env.PIX_ACP_SESSION_STATE_BRIDGE === "1"));
}

/** No tool registration, agent continuations, custom messages or transcript mutations. */
export default function headsUp(pi: ExtensionAPI, settingsLoader = loadHeadsUpSettings): void {
	let controller: HeadsUpController | undefined;
	let owner: ExtensionContext | undefined;
	let epoch = 0;
	let expanded = false;
	let awaitingUserRecord = false;
	let uiBlocked = false;
	let removeAbort: (() => void) | undefined;
	let initializing: Promise<void> | undefined;

	function render(): void {
		if (!controller || !owner) return;
		try { presentHeadsUp(owner, controller.snapshot(), expanded); } catch { /* Superseded UI scope. */ }
	}
	function seed(ctx: ExtensionContext, target: HeadsUpController): void {
		// Once on explicit activation / branch replacement, not per streamed chunk.
		const entries = ctx.sessionManager.buildSessionProjection().entries;
		target.context.reset();
		const first = entries.find((entry) => entry.messages.some((message) => message.role === "user"));
		if (first) for (const message of first.messages) if (message.role === "user") target.context.addMessage(message, first.sourceEntry.id);
		const users = entries.filter((entry) => entry.messages.some((message) => message.role === "user")).slice(-3);
		for (const entry of entries.slice(-64)) for (const message of entry.messages) target.context.addMessage(message, entry.sourceEntry.id);
		for (const entry of users) for (const message of entry.messages) if (message.role === "user") target.context.addMessage(message, entry.sourceEntry.id);
	}
	async function initialize(ctx: ExtensionContext): Promise<void> {
		const ticket = ++epoch;
		removeAbort?.(); removeAbort = undefined;
		controller?.dispose(); controller = undefined; owner = ctx;
		expanded = false; awaitingUserRecord = false; uiBlocked = false;
		if (!observerRuntimeAllowed(ctx)) return;
		const settings = await settingsLoader(ctx.cwd, ctx.isProjectTrusted());
		if (ticket !== epoch) return;
		const manager = ctx.sessionManager;
		const registry = ctx.modelRegistry;
		const usage = observerUsageRecorder(manager);
		const next = new HeadsUpController({
			config: settings.config,
			allowed: () => { try { return ticket === epoch && observerRuntimeAllowed(ctx); } catch { return false; } },
			findModel: (ref) => {
				const slash = ref.indexOf("/");
				const model = registry.find(ref.slice(0, slash), ref.slice(slash + 1));
				return model && registry.hasConfiguredAuth(model) ? model : undefined;
			},
			request: (request) => requestHeadsUp(registry, request),
			prepareContext: () => seed(ctx, next),
			canAccountUsage: usage.available, accountUsage: usage.record,
			publish: (snapshot) => {
				if (ticket !== epoch) return;
				try { pi.events.emit("heads-up", snapshot); presentHeadsUp(ctx, snapshot, expanded); } catch { /* UI is optional. */ }
			},
		});
		controller = next; next.setModel(settings.model);
		if (settings.enabled) { seed(ctx, next); next.setEnabled(true); }
	}
	function invalidate(reason: string, clearContext = false): void { expanded = false; controller?.invalidateForLifecycle(reason, clearContext); }
	function shutdown(): void {
		controller?.dispose(); ++epoch; removeAbort?.(); removeAbort = undefined;
		controller = undefined; owner = undefined;
	}
	pi.on("session_start", (_event, ctx) => {
		const run = initialize(ctx); initializing = run;
		return run.finally(() => { if (initializing === run) initializing = undefined; });
	});
	pi.on("session_shutdown", shutdown);
	pi.on("input", (event) => {
		if (event.source !== "extension") { awaitingUserRecord = true; invalidate("new user request"); }
	});
	pi.on("agent_start", (_event, ctx) => {
		removeAbort?.(); removeAbort = undefined;
		const signal = ctx.signal;
		if (!signal) return;
		const abort = () => invalidate("agent stopped");
		signal.addEventListener("abort", abort, { once: true });
		removeAbort = () => signal.removeEventListener("abort", abort);
	});
	pi.on("agent_before_settle", (event) => { if (event.outcome !== "completed") invalidate("agent stopped or failed"); });
	pi.on("agent_settled", () => { removeAbort?.(); removeAbort = undefined; });
	pi.on("turn_end", (event) => {
		const current = controller;
		if (!current?.isEnabled) return;
		if (event.outcome !== "completed") { invalidate("agent stopped or failed"); return; }
		if (awaitingUserRecord) {
			const user = event.context.contextEntries.slice(-96).toReversed().find((entry) => entry.messages.some((message) => message.role === "user"));
			if (user) {
				for (const message of user.messages) if (message.role === "user") current.context.addMessage(message, user.sourceEntry.id);
				awaitingUserRecord = false;
			}
		}
		current.noteTurn(event.message, event.messageEntryId, event.toolResults, event.toolResultEntryIds);
		// Do not return/await this promise: the primary turn must remain unblocked.
		void current.check().catch(() => {});
	});
	pi.on("model_select", () => invalidate("main model changed"));
	pi.on("session_before_switch", () => invalidate("session switching", true));
	pi.on("session_before_fork", () => invalidate("session forking", true));
	pi.on("session_before_tree", () => invalidate("branch changing", true));
	pi.on("session_before_compact", () => invalidate("context compacting", true));
	pi.on("session_tree", (_event, ctx) => { if (controller?.isEnabled) seed(ctx, controller); });
	pi.on("session_compact", (_event, ctx) => { if (controller?.isEnabled) seed(ctx, controller); });
	pi.on("session_compact_failed", (_event, ctx) => { if (controller?.isEnabled) seed(ctx, controller); });
	pi.on("ui_prompt_start", () => { uiBlocked = true; });
	pi.on("ui_prompt_end", () => { uiBlocked = false; });

	pi.registerCommand("heads-up", {
		description: "Passive observer: on | off | check | status | snapshot | model provider/id | explain | discuss | dismiss | known | irrelevant",
		handler: async (args, ctx) => {
			const commandEpoch = epoch;
			await initializing;
			if (commandEpoch !== epoch) return;
			const current = controller;
			const [action = "status", value] = args.trim().split(/\s+/).filter(Boolean);
			// Popup consumers request this after subscribing; it is deliberately quiet and read-only.
			if (current && action === "snapshot") { current.refreshStatus(); return; }
			if (current && action === "off") { current.setEnabled(false); return; }
			if (!current || !observerRuntimeAllowed(ctx)) { ctx.ui.notify("Heads up is unavailable in this runtime or offline mode.", "info"); return; }
			if (action === "on") { seed(ctx, current); current.setEnabled(true); }
			else if (action === "off") current.setEnabled(false);
			else if (action === "check") { void current.check(true).catch(() => {}); }
			else if (action === "model" && value) { if (!current.setModel(value)) ctx.ui.notify("Use /heads-up model provider/model-id", "info"); }
			else if (["dismiss", "known", "irrelevant"].includes(action)) {
				const id = value ?? current.currentNotice?.id;
				if (id) current.feedbackNotice(id, action as "dismiss" | "known" | "irrelevant");
			} else if (action === "explain") { if (current.explain(value)) { expanded = !expanded; render(); } }
			else if (action === "discuss") {
				const notice = current.explain(value);
				const ui = ctx.ui as typeof ctx.ui & { getEditorSnapshot?: () => { text: string; images: readonly unknown[] } };
				const draft = ui.getEditorSnapshot?.();
				if (!notice || uiBlocked || ctx.mode !== "tui" || !draft || draft.text !== "" || draft.images.length > 0) {
					ctx.ui.notify("Use an empty composer with no attachments to insert a note; Desktop has an Insert question button.", "info"); return;
				}
				ui.setEditorText(headsUpDiscussionDraft(notice));
			} else if (action !== "status") { ctx.ui.notify("Use /heads-up on, off, check, status, snapshot, model, explain, discuss, dismiss, known or irrelevant.", "info"); return; }
			if (action === "status" || action === "check" || action === "on" || action === "model") {
				const state = current.snapshot();
				ctx.ui.notify(`Heads up: ${state.phase} · ${state.model}\n${state.checks} checks · ${state.inputTokens} input/cache tokens · ${state.outputTokens} output tokens${state.reason ? `\n${state.reason}` : ""}`, "info");
			}
		},
	});
}
