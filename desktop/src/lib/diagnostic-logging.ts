import { invoke } from "@tauri-apps/api/core";

export type DiagnosticContext = { workspace: string; sessionId?: string | null };
/** Static, payload-free events accepted by the native diagnostic writer. */
export type DesktopDiagnosticEvent =
  | "acp:connecting" | "acp:ready" | "acp:reconnecting" | "acp:stopped"
  | "acp:unexpected-exit" | "acp:connect-failed"
  | "updater:checking" | "updater:available" | "updater:current" | "updater:check-failed"
  | "updater:installing" | "updater:ready" | "updater:install-failed" | "updater:restart-failed";

/** Bounded IPC; a failed logging command must never become another UI error. */
export function createDiagnosticLogger(context: () => DiagnosticContext, send = invoke) {
  let pending = 0;
  let disposed = false;
  let generation = 0;
  let stopCurrent: (() => void) | undefined;
  function enqueue(command: string, args: Record<string, unknown>): void {
    const owner = generation;
    pending++;
    void Promise.resolve().then(() => disposed || owner !== generation ? undefined : send(command, args))
      .catch(() => {}).finally(() => { pending--; });
  }
  function report(error: unknown, event = "frontend:error"): void {
    if (disposed || pending >= 16) return;
    let scope: DiagnosticContext;
    let diagnostic: string;
    try {
      scope = context(); // Snapshot before asynchronous work, not at completion.
      diagnostic = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    } catch { return; }
    enqueue("log_desktop_diagnostic", {
      event, diagnostic: diagnostic.slice(0, 8192), workspace: scope.workspace || null,
      sessionId: scope.sessionId ?? null,
    });
  }
  function record(event: DesktopDiagnosticEvent): void {
    if (disposed || pending >= 16) return;
    try {
      const scope = context();
      enqueue("log_desktop_event", { event, workspace: scope.workspace || null, sessionId: scope.sessionId ?? null });
    } catch { /* Diagnostics must not interrupt the frontend. */ }
  }
  function start(target: Window = window): () => void {
    stopCurrent?.();
    disposed = false;
    const owner = ++generation;
    const error = (event: ErrorEvent): void => {
      // Browser layout-loop notices carry no exception and are not application
      // crashes. Keep real ResizeObserver exceptions (event.error) observable.
      if (!event.error && (event.message === "ResizeObserver loop completed with undelivered notifications."
        || event.message === "ResizeObserver loop limit exceeded")) return;
      report(event.error ?? event.message, "frontend:uncaught");
    };
    const rejection = (event: PromiseRejectionEvent): void => report(event.reason, "frontend:unhandled-rejection");
    target.addEventListener("error", error);
    target.addEventListener("unhandledrejection", rejection);
    stopCurrent = () => {
      if (owner !== generation) return;
      disposed = true;
      generation++;
      target.removeEventListener("error", error);
      target.removeEventListener("unhandledrejection", rejection);
      stopCurrent = undefined;
    };
    return stopCurrent;
  }
  return { report, record, start };
}
