import type { AcpClient } from "../lib/acp-client";
import type { ForkReadyNotification } from "../lib/acp-client-types";
import type { DesktopSessionServices } from "./desktop-session-services";

type Options = {
  client: () => AcpClient | null;
  workspace: () => string;
  sessions: Pick<DesktopSessionServices, "history" | "runtime" | "catalog" | "tabs">;
  reportError: (error: unknown) => void;
};

/** Adopt ACP-created forks without changing active conversation, draft or focus. */
export function createBackgroundForkController(options: Options) {
  const pending = new WeakMap<AcpClient, Set<string>>();

  async function handleReady(notification: ForkReadyNotification): Promise<void> {
    const client = options.client();
    const workspace = options.workspace();
    if (!client || notification.cwd !== workspace) return;
    const { sessionId } = notification;
    let accepted = pending.get(client);
    if (!accepted) pending.set(client, accepted = new Set());
    if (accepted.has(sessionId) || options.sessions.runtime.isReady(sessionId)) return;
    accepted.add(sessionId);
    const current = () => client === options.client() && workspace === options.workspace();
    try {
      // Prime before exposing the tab or enabling auto-queue drain, so selection
      // never mistakes a live-only transcript for the fork's complete history.
      const primed = await options.sessions.history.primeBackground(client, sessionId, workspace);
      if (!current() || !primed) return;
      options.sessions.catalog.ensureProvisional(sessionId, workspace);
      options.sessions.tabs.show(sessionId);
      const loading = options.sessions.runtime.ensure(client, sessionId, workspace);
      const ownsRuntime = options.sessions.runtime.captureOwnership(sessionId);
      await loading;
      if (!current() || !ownsRuntime()) return;
      if (!options.sessions.runtime.isReady(sessionId)) {
        throw new Error("Could not start the background fork. Its message remains queued; reopen the fork to retry.");
      }
      void options.sessions.catalog.refresh();
    } catch (error) {
      if (current()) options.reportError(error);
    } finally {
      accepted.delete(sessionId);
    }
  }

  return { handleReady };
}
