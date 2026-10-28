import type { SessionInfo } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import { isSubagentSession } from "../lib/session-subagent-link";

type RenameRequest = { sessionId: string; title: string; client: AcpClient; workspace: string };

export function createSessionRename(options: {
  client: () => AcpClient | null;
  workspace: () => string;
  sessions: () => readonly SessionInfo[];
  isOpen: (sessionId: string) => boolean;
  isBusy: (sessionId: string) => boolean;
  ensureRuntime: (client: AcpClient, sessionId: string, workspace: string) => Promise<void>;
  runtimeReady: (sessionId: string) => boolean;
  refreshSessions: () => Promise<void>;
  reportError: (error: unknown) => void;
}) {
  let request = $state.raw<RenameRequest | null>(null);
  let saving = $state(false);

  function canRename(sessionId: string): boolean {
    const session = options.sessions().find((item) => item.sessionId === sessionId);
    return Boolean(options.client() && options.workspace() && session && !isSubagentSession(session)
      && options.isOpen(sessionId) && !options.isBusy(sessionId));
  }
  function cancel(): void { request = null; saving = false; }
  function isCurrent(owner: RenameRequest): boolean {
    return request === owner && options.client() === owner.client && options.workspace() === owner.workspace
      && canRename(owner.sessionId);
  }
  function open(sessionId: string): void {
    if (request || !canRename(sessionId)) return;
    request = {
      sessionId, title: options.sessions().find((item) => item.sessionId === sessionId)?.title ?? "",
      client: options.client()!, workspace: options.workspace(),
    };
  }
  async function submit(value: string): Promise<void> {
    const owner = request;
    const name = value.trim();
    if (!owner || saving || !name || /[\r\n]/u.test(name) || !isCurrent(owner)) return;
    saving = true;
    try {
      await options.ensureRuntime(owner.client, owner.sessionId, owner.workspace);
      if (!isCurrent(owner)) return;
      if (!options.runtimeReady(owner.sessionId)) throw new Error("Session is not ready to rename. Please try again.");
      // ACP intercepts /name as a local built-in; it never invokes the model.
      await owner.client.prompt(owner.sessionId, [{ type: "text", text: `/name ${name}` }]);
      if (!isCurrent(owner)) return;
      await options.refreshSessions();
      if (request === owner) cancel();
    } catch (error) {
      options.reportError(error);
    } finally {
      if (request === owner) saving = false;
    }
  }
  function reconcile(): void {
    if (request && !isCurrent(request)) cancel();
  }
  return { get request() { return request; }, get saving() { return saving; }, canRename, open, submit, cancel, reconcile };
}
