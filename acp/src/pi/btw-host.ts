import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";
import { BTW_RPC_PREFIX, parseBtwCommand } from "../btw/contract.js";
import { BtwService } from "../btw/service.js";

const hosts = new WeakMap<AgentSession, BtwService>();
const installed = new WeakSet<object>();

/** The existing RPC adapter already owns this narrow private event-emission boundary. */
function emit(session: AgentSession, event: unknown): void {
	(session as unknown as { _emit: (event: unknown) => void })._emit(event);
}

function host(session: AgentSession): BtwService {
	let service = hosts.get(session);
	if (service && !service.isClosed) return service;
	// Rebinding extensions can retain the same AgentSession and ModelRuntime.
	// Do not create a new physical request while an old provider ignores abort.
	if (service?.isBusy) throw new Error("Previous BTW request is still shutting down");
	const manager = session.sessionManager;
	const ownerId = manager.getSessionId();
	service = new BtwService({
		sessionId: ownerId,
		readBranch: () => manager.getBranch(),
		readProjection: () => manager.buildSessionProjection(),
		resolveModel: (ref) => {
			const slash = ref?.indexOf("/") ?? -1;
			const model = ref ? session.modelRuntime.getModel(ref.slice(0, slash), ref.slice(slash + 1)) : session.routedModel?.model ?? session.model;
			if (!model || !session.modelRuntime.hasConfiguredAuth(model.provider)) throw new Error("BTW model or credentials are unavailable");
			return model;
		},
		readThinkingLevel: () => session.routedModel?.thinkingLevel ?? session.thinkingLevel,
		stream: (model, context, options) => session.modelRuntime.streamSimple(model, context, options),
		account: (message) => {
			if (manager.getSessionId() !== ownerId || typeof manager.appendUsage !== "function") throw new Error("BTW usage owner changed");
			manager.appendUsage("btw", message.provider, message.model, message.usage, "side question");
		},
		publish: (data) => emit(session, { type: "pix_btw_event", data }),
		allowed: () => !/^(1|true|yes|on)$/i.test(process.env.PI_OFFLINE ?? "") && !process.env.PI_SUBAGENT_AGENT_DIR,
	});
	hosts.set(session, service);
	return service;
}

/** Binding/reload/replacement owns lifetime. No extra worker or tool registration. */
export function installBtwHost(Session: typeof AgentSession): void {
	if (installed.has(Session.prototype)) return;
	installed.add(Session.prototype);
	const retire = (session: AgentSession) => { hosts.get(session)?.dispose(); };
	const originalDispose = Session.prototype.dispose;
	Session.prototype.dispose = function () { retire(this); return originalDispose.call(this); };
	const originalBind = Session.prototype.bindExtensions;
	Session.prototype.bindExtensions = function (bindings) { retire(this); return originalBind.call(this, bindings); };
	const originalTree = Session.prototype.navigateTree;
	Session.prototype.navigateTree = function (...args) { hosts.get(this)?.invalidateContext(); return originalTree.apply(this, args); };
}

/** Called before the normal prompt dispatcher; all malformed BTW requests fail closed. */
export function handleBtwPrompt(session: AgentSession, text: string, options?: PromptOptions): boolean {
	if (!text.startsWith(BTW_RPC_PREFIX)) return false;
	if (text.length > 200_000) throw new Error("BTW request is too large");
	const envelope: unknown = JSON.parse(text.slice(BTW_RPC_PREFIX.length));
	if (!envelope || typeof envelope !== "object" || !("rpcId" in envelope) || typeof envelope.rpcId !== "string"
		|| !/^[a-zA-Z0-9._:-]{1,128}$/.test(envelope.rpcId) || !("command" in envelope)) throw new Error("Invalid BTW RPC envelope");
	const command = parseBtwCommand(envelope.command);
	const state = host(session).command(command);
	emit(session, { type: "pix_btw_response", rpcId: envelope.rpcId, state });
	options?.preflightResult?.("handled");
	return true;
}
