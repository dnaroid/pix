import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { SvelteMap } from "svelte/reactivity";
import { windowLayoutKey } from "../lib/window-layout-storage";
import {
  sessionTabModel, serializeSessionTabModels,
  type SessionTabModel, type SessionTabModels,
} from "../lib/session-tab-model";

export function createSessionTabModelState() {
  const storageKey = windowLayoutKey("sessionTabModels");
  let projects = $state.raw(new SvelteMap<string, Map<string, SessionTabModel>>());

  function persist(): void {
    try { localStorage.setItem(storageKey, serializeSessionTabModels(projects)); }
    catch { /* Display persistence is best effort. */ }
  }

  function remember(workspace: string, sessionId: string, configOptions: readonly SessionConfigOption[]): void {
    const next = sessionTabModel(configOptions);
    const existing = projects.get(workspace)?.get(sessionId);
    if (existing?.modelRef === next?.modelRef && existing?.modelName === next?.modelName
      && existing?.thinking === next?.thinking) return;
    const sessions = new Map(projects.get(workspace));
    if (next) sessions.set(sessionId, next);
    else sessions.delete(sessionId);
    if (sessions.size) projects.set(workspace, sessions);
    else projects.delete(workspace);
    persist();
  }

  function retain(workspace: string, sessionIds: readonly string[]): void {
    const existing = projects.get(workspace);
    if (!existing) return;
    const ids = new Set(sessionIds);
    const retained = new Map([...existing].filter(([id]) => ids.has(id)));
    if (retained.size === existing.size) return;
    if (retained.size) projects.set(workspace, retained);
    else projects.delete(workspace);
    persist();
  }

  return {
    restore(value: SessionTabModels) { projects = new SvelteMap(value); },
    get: (workspace: string, sessionId: string) => projects.get(workspace)?.get(sessionId),
    remember,
    retain,
  };
}
