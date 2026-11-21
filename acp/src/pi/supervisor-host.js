import { randomUUID } from "node:crypto";
import { SUPERVISOR_RESPONSE_PREFIX } from "../acp/supervisor-contract.js";
import { isSupervisorSetupOp, SUPERVISOR_SETUP_TIMEOUT_MS } from "../acp/supervisor-setup-contract.js";

/**
 * Pi-side half of the `supervisor` tool bridge (decision 0077). Installed only
 * in the project supervisor's runtime (ACP sets PIX_SUPERVISOR_BRIDGE=1 for it).
 * Requests are correlated by random id per physical runtime, so a replaced
 * runtime never receives another runtime's reply.
 */
const HOST = Symbol.for("pix.supervisor.request");
const bridges = new WeakMap();
const installed = new WeakSet();

export function createSupervisorBridge(session, emit, timeoutMs = 60_000) {
  const pending = new Map();
  let closed = false;
  /**
   * @param {{ ownerSessionId: string, op: string, sessionId?: string }} input
   * @param {AbortSignal} [signal]
   */
  const request = (input, signal) => {
    const { ownerSessionId, ...body } = input;
    signal?.throwIfAborted();
    if (closed || session.sessionManager.getSessionId() !== ownerSessionId) throw new Error("Supervisor runtime was replaced");
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      let timer;
      const finish = (value, error) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      const setup = isSupervisorSetupOp(body.op);
      const cancel = (message) => {
        if (setup && pending.has(requestId)) {
          try { emit({ type: "pix_supervisor_setup_cancel", requestId }); } catch { /* Transport retiring. */ }
        }
        finish(undefined, new Error(message));
      };
      const abort = () => cancel("Supervisor request cancelled");
      pending.set(requestId, { finish, cancel });
      signal?.addEventListener("abort", abort, { once: true });
      // Let ACP expire and reply first; this timer is a transport fallback.
      timer = setTimeout(() => cancel("Supervisor request timed out"), setup ? SUPERVISOR_SETUP_TIMEOUT_MS + 5_000 : timeoutMs);
      timer.unref?.();
      try { emit({ type: "pix_supervisor_request", requestId, request: body }); }
      catch (error) { finish(undefined, error); }
    });
  };
  return {
    request,
    respond(envelope) {
      const request = pending.get(envelope.requestId);
      if (!request) return; // cancelled, timed out or an old runtime's late reply
      const { finish } = request;
      if (typeof envelope.error === "string") finish(undefined, new Error(envelope.error));
      else finish(envelope.result);
    },
    dispose() {
      closed = true;
      for (const { cancel } of [...pending.values()]) cancel("Supervisor runtime closed");
    },
  };
}

export function installSupervisorHost(Session) {
  if (installed.has(Session.prototype)) return;
  installed.add(Session.prototype);
  const retire = (session) => {
    const bridge = bridges.get(session);
    bridge?.dispose();
    if (globalThis[HOST] === bridge?.request) delete globalThis[HOST];
    bridges.delete(session);
  };
  const bind = Session.prototype.bindExtensions;
  Session.prototype.bindExtensions = function (bindings) {
    retire(this);
    const result = bind.call(this, bindings);
    const bridge = createSupervisorBridge(this, (event) => this._emit(event));
    bridges.set(this, bridge);
    globalThis[HOST] = bridge.request;
    return result;
  };
  const dispose = Session.prototype.dispose;
  Session.prototype.dispose = function () { retire(this); return dispose.call(this); };
}

export function handleSupervisorResponse(session, text, options) {
  if (!text.startsWith(SUPERVISOR_RESPONSE_PREFIX)) return false;
  if (text.length > 2 * 1024 * 1024) throw new Error("Supervisor response is too large");
  const envelope = JSON.parse(text.slice(SUPERVISOR_RESPONSE_PREFIX.length));
  if (!envelope || typeof envelope.requestId !== "string") throw new Error("Invalid supervisor response");
  bridges.get(session)?.respond(envelope);
  options?.preflightResult?.("handled");
  return true;
}
