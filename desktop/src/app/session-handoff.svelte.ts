import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { PromptRunCompletion } from "./prompt-run-lifecycle.svelte";
import {
  sessionHandoffPath, sessionHandoffPrompt, sessionHandoffContinuationPrompt,
  isCompleteSessionHandoff,
} from "./session-handoff-prompts";

type HandoffOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  sessionId: () => string | null;
  canStart: () => boolean;
  captureOwnership: () => () => boolean;
  isIdle: (sessionId: string) => boolean;
  holdAutoQueue: (sessionId: string) => () => void;
  runPrompt: (client: AcpClient, sessionId: string, text: string) => Promise<PromptRunCompletion | undefined>;
  readHandoff: (workspace: string, path: string) => Promise<string>;
  commitSession: (sourceId: string, newId: string, config: SessionConfigOption[]) => void;
  discardSession: (sessionId: string) => void;
  reportError: (error: unknown) => void;
};

/** Prepare off-screen; publish only after the source run, file, and new runtime succeed. */
export function createSessionHandoff(options: HandoffOptions) {
  let busySessionId = $state<string | null>(null);

  async function start(): Promise<void> {
    const client = options.client();
    const sourceId = options.sessionId();
    const workspace = options.workspace();
    if (busySessionId || !client || !sourceId || !workspace || !options.canStart()) return;
    const ownsSource = options.captureOwnership();
    const contextCurrent = () => options.client() === client && options.workspace() === workspace
      && options.sessionId() === sourceId && ownsSource();
    busySessionId = sourceId;
    const releaseQueue = options.holdAutoQueue(sourceId);
    let createdId: string | undefined;
    let committed = false;
    try {
      const path = sessionHandoffPath();
      const completion = await options.runPrompt(client, sourceId, sessionHandoffPrompt(path));
      if (!contextCurrent() || !completion?.isCurrent()) return;
      if (completion.stopReason !== "end_turn") {
        if (completion.stopReason !== "cancelled") {
          throw new Error(`Handoff did not complete (${completion.stopReason}); the current session was kept.`);
        }
        return;
      }
      const canCommit = () => contextCurrent() && completion.isCurrent()
        && options.canStart() && options.isIdle(sourceId);
      if (!canCommit()) return;
      const content = await options.readHandoff(workspace, path);
      if (!canCommit()) return;
      if (!isCompleteSessionHandoff(content)) {
        throw new Error(`Handoff file is empty or incomplete: ${path}. The current session was kept.`);
      }
      const created = await client.newSession(workspace);
      createdId = created.sessionId;
      if (!canCommit()) return;
      const loaded = await client.loadSession(createdId, workspace);
      if (!canCommit()) return;
      options.commitSession(sourceId, createdId, loaded.configOptions ?? created.configOptions ?? []);
      committed = true;
      await options.runPrompt(client, createdId, sessionHandoffContinuationPrompt(path));
    } catch (error) {
      // Never surface a late source error in a different conversation/workspace.
      if (contextCurrent() || (committed && options.client() === client
        && options.workspace() === workspace && options.sessionId() === createdId)) options.reportError(error);
    } finally {
      if (createdId && !committed) {
        options.discardSession(createdId);
        void client.closeSession(createdId).catch(() => undefined);
      }
      busySessionId = null;
      releaseQueue();
    }
  }

  return { get busySessionId() { return busySessionId; }, start };
}
