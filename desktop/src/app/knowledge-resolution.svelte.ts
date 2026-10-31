import type { AcpClient } from "../lib/acp-client";
import type { KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
import {
  knowledgeBatchResolutionPrompt,
  knowledgeResolutionPrompt,
  type KnowledgeBatchResolutionRequest,
  type KnowledgeResolutionRequest,
} from "../lib/knowledge-resolution";
import type { ProjectWikiConfig } from "../lib/project-wiki";
import { wikiMigrationPrompt } from "../lib/wiki-migration-prompt";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import type { createPromptRuntime } from "./prompt-runtime.svelte";

interface KnowledgeResolutionOptions {
  readonly client: () => AcpClient | null;
  readonly workspace: () => string;
  readonly generation: () => number;
  readonly ready: () => boolean;
  readonly operationRunning: () => boolean;
  readonly runtime: Pick<ReturnType<typeof createSessionRuntimeStore>, "ensure" | "isReady">;
  readonly prompts: Pick<ReturnType<typeof createPromptRuntime>, "runPromptRequest">;
  readonly forgetRuntime: (sessionId: string) => void;
  readonly activate: (sessionId: string, workspace: string, prompt: string) => string;
  readonly onStarted: (sessionId: string) => void;
  readonly refreshSessions: () => void | Promise<void>;
  readonly reportError: (error: unknown) => void;
}

interface LaunchOwner { readonly client: AcpClient; readonly workspace: string; readonly generation: number; }

/** Explicit report action. Merely viewing or expanding a report never starts a session. */
export function createKnowledgeResolution(options: KnowledgeResolutionOptions) {
  let owner: LaunchOwner | undefined;
  let starting = $state(false);
  const environmentCurrent = (request: LaunchOwner) => request.client === options.client()
    && request.workspace === options.workspace() && request.generation === options.generation();

  /** Single-report or single-finding resolution. */
  async function start(input: KnowledgeResolutionRequest): Promise<void> {
    await launch(input.workspace, input.result.reportLanguage, () => knowledgeResolutionPrompt(input));
  }

  /** One session for a basket of saved findings; resolves true once the prompt is sent. */
  function startBatch(input: KnowledgeBatchResolutionRequest): Promise<boolean> {
    return launch(input.workspace, input.language, async () => knowledgeBatchResolutionPrompt(input));
  }

  /** Fresh session that moves existing docs/specs into an empty Wiki; resolves true once the prompt is sent. */
  function startWikiMigration(workspace: string, config: ProjectWikiConfig): Promise<boolean> {
    return launch(workspace, undefined, async () => wikiMigrationPrompt(config),
      "Could not prepare a new session to migrate documentation into the Wiki.");
  }

  async function launch(workspace: string, language: KnowledgeReportLanguage | undefined,
    buildPrompt: () => Promise<string>, prepareError?: string): Promise<boolean> {
    const client = options.client();
    if (!client || !options.ready() || options.operationRunning() || workspace !== options.workspace()
      || (starting && owner && environmentCurrent(owner))) return false;
    const request = { client, workspace, generation: options.generation() };
    owner = request;
    starting = true;
    let createdSessionId: string | undefined;
    let launched = false;
    const current = () => owner === request && environmentCurrent(request);
    const closeCreated = async () => {
      if (!createdSessionId) return;
      options.forgetRuntime(createdSessionId);
      await client.closeSession(createdSessionId).catch(options.reportError);
      createdSessionId = undefined;
    };
    try {
      const prompt = await buildPrompt();
      if (!current()) return false;
      const created = await client.newSession(request.workspace);
      createdSessionId = created.sessionId;
      if (!current()) { await closeCreated(); return false; }
      await options.runtime.ensure(client, created.sessionId, request.workspace);
      if (!current()) { await closeCreated(); return false; }
      if (!options.runtime.isReady(created.sessionId)) throw new Error(prepareError ?? (language === "ru"
        ? "Не удалось подготовить новую сессию для разбора противоречий."
        : "Could not prepare a new session to resolve the Wiki findings."));
      const messageId = options.activate(created.sessionId, request.workspace, prompt);
      const run = options.prompts.runPromptRequest(client, created.sessionId, [{ type: "text", text: prompt }], [], messageId);
      launched = true;
      void run.then(() => {
        if (environmentCurrent(request)) return options.refreshSessions();
      }).catch(error => { if (environmentCurrent(request)) options.reportError(error); });
      options.onStarted(created.sessionId);
      void Promise.resolve(options.refreshSessions()).catch(error => { if (environmentCurrent(request)) options.reportError(error); });
      return true;
    } catch (error) {
      if (!launched) await closeCreated();
      if (environmentCurrent(request)) options.reportError(error);
      return false;
    } finally {
      if (owner === request) { owner = undefined; starting = false; }
    }
  }

  return { start, startBatch, startWikiMigration, get starting() { return starting && Boolean(owner && environmentCurrent(owner)); } };
}
