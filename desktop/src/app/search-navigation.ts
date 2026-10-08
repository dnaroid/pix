import type { SearchHit } from "../lib/universal-search";

export interface SearchNavigationOptions {
  workspace: () => string;
  connection: () => unknown;
  activeSession: () => string | null;
  openSetting: (section: string, fieldId: string) => Promise<void>;
  taskExists: (taskId: string) => Promise<boolean>;
  openTask: (taskId: string, isCurrent: () => boolean) => Promise<void>;
  loadSession: (id: string) => Promise<void>;
  activateSession: (id: string) => void;
  hydrate: (id: string) => Promise<void>;
  fileExists: (path: string) => Promise<boolean>;
  openFile: (path: string, range: { startLine: number; endLine: number }) => Promise<void>;
  openCommit: (hit: Extract<SearchHit, { kind: "commits" }>, isCurrent: () => boolean) => Promise<void>;
}

export function createSearchNavigation(options: SearchNavigationOptions) {
  let generation = 0;
  const cancel = () => { generation++; };
  async function open(hit: SearchHit): Promise<void> {
    const revision = ++generation;
    const workspace = options.workspace();
    const connection = options.connection();
    const current = () => generation === revision && options.workspace() === workspace && options.connection() === connection;
    if (hit.kind === "settings") {
      await options.openSetting(hit.section, hit.fieldId);
    } else if (hit.kind === "sessions") {
      if (!connection) throw new Error("The session search backend is disconnected.");
      await options.loadSession(hit.sessionId);
      if (!current()) return;
      if (options.activeSession() !== hit.sessionId) throw new Error("This session is no longer available.");
      options.activateSession(hit.sessionId);
      const sessionCurrent = () => current() && options.activeSession() === hit.sessionId;
      await options.hydrate(hit.sessionId);
      if (!sessionCurrent()) return;
    } else if (hit.kind === "tasks") {
      const exists = await options.taskExists(hit.taskId);
      if (!current()) return;
      if (!exists) throw new Error("This task is no longer available.");
      await options.openTask(hit.taskId, current);
    } else if (hit.kind === "commits") {
      await options.openCommit(hit, current);
    } else if (hit.kind === "code" || hit.kind === "knowledge") {
      const exists = await options.fileExists(hit.path);
      if (!current()) return;
      if (!exists) throw new Error("This indexed file is no longer available.");
      await options.openFile(hit.path, { startLine: hit.startLine, endLine: hit.endLine });
    }
  }
  return { open, cancel };
}
