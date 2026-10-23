import { randomUUID } from "node:crypto";
import { TASK_RUN_RESPONSE_PREFIX, parseTaskRunResult } from "../acp/task-run-contract.js";

const HOST = Symbol.for("pix.project-tasks.run");
const bridges = new WeakMap();
const installed = new WeakSet();

/** One bridge per physical runtime; no saved-session state or task storage writes. */
export function createTaskRunBridge(session, emit, timeoutMs = 120_000) {
  const pending = new Map();
  let closed = false;
  const launch = ({ taskId, sessionId }, signal) => {
    signal?.throwIfAborted();
    if (closed || session.sessionManager.getSessionId() !== sessionId) throw new Error("Task launch runtime was replaced");
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      let timer;
      const finish = (value, error) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        // Cancellation is best effort once Desktop has accepted the launch.
        try { emit({ type: "pix_task_run_cancel", requestId }); } catch { /* Retiring transport. */ }
        finish(undefined, new Error("Task launch cancelled; inspect the task sessionId before retrying"));
      };
      pending.set(requestId, finish);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, timeoutMs);
      timer.unref?.();
      try { emit({ type: "pix_task_run_request", requestId, taskId }); }
      catch (error) { finish(undefined, error); }
    });
  };
  return {
    launch,
    respond(envelope) {
      const finish = pending.get(envelope.requestId);
      if (!finish) return; // cancelled or an old runtime's late reply
      if (typeof envelope.error === "string") finish(undefined, new Error(envelope.error));
      else {
        try { finish(parseTaskRunResult(envelope.result)); }
        catch (error) { finish(undefined, error); }
      }
    },
    dispose() {
      closed = true;
      for (const [requestId, finish] of pending) {
        try { emit({ type: "pix_task_run_cancel", requestId }); } catch { /* Retiring transport. */ }
        finish(undefined, new Error("Task launch runtime closed; inspect the task before retrying"));
      }
    },
  };
}

export function installTaskRunHost(Session) {
  if (installed.has(Session.prototype)) return;
  installed.add(Session.prototype);
  const retire = (session) => {
    const bridge = bridges.get(session);
    bridge?.dispose();
    if (globalThis[HOST] === bridge?.launch) delete globalThis[HOST];
    bridges.delete(session);
  };
  const bind = Session.prototype.bindExtensions;
  Session.prototype.bindExtensions = function (bindings) {
    retire(this);
    const result = bind.call(this, bindings);
    const bridge = createTaskRunBridge(this, (event) => this._emit(event));
    bridges.set(this, bridge);
    globalThis[HOST] = bridge.launch;
    return result;
  };
  const dispose = Session.prototype.dispose;
  Session.prototype.dispose = function () { retire(this); return dispose.call(this); };
}

export function handleTaskRunResponse(session, text, options) {
  if (!text.startsWith(TASK_RUN_RESPONSE_PREFIX)) return false;
  if (text.length > 16_384) throw new Error("Task launch response is too large");
  const envelope = JSON.parse(text.slice(TASK_RUN_RESPONSE_PREFIX.length));
  if (!envelope || typeof envelope.requestId !== "string") throw new Error("Invalid task launch response");
  bridges.get(session)?.respond(envelope);
  options?.preflightResult?.("handled");
  return true;
}
