import { getProjectWikiConfig } from "../lib/project-wiki";
import { readSearchSourceSelection } from "../lib/search-source-selection";
import { editWikiAutoCheckSettings, getWikiAutoCheckSettings } from "../lib/wiki-auto-check-config";
import { persistWorkspaceConfigEdit, readWorkspaceConfig, type WorkspaceConfigEdit } from "./workspace-config-persistence";
import type { WikiAutoCheckConfiguration } from "./wiki-auto-check.svelte";

interface SettingsOptions {
  readonly workspace: () => string;
  readonly generation: () => number;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly reportError: (error: unknown, workspace: string) => void;
}

interface Owner { readonly workspace: string; readonly generation: number; readonly epoch: number; }
interface Initialization { readonly owner: Owner; readonly pending: Promise<void>; }
class InitializationAlreadyResolved extends Error {}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 600);

/** Owns setting UI lifetime separately from accepted writes to their original workspace. */
export function createWikiAutoCheckSettingsOwner(options: SettingsOptions) {
  let saving = $state(false);
  let error = $state<string | undefined>();
  let persistedEnabled = $state<boolean | undefined>();
  let epoch = 0;
  let mutation: Owner | undefined;
  let initialization: Initialization | undefined;

  function capture(workspace = options.workspace()): Owner {
    return { workspace, generation: options.generation(), epoch };
  }
  function current(owner: Owner): boolean {
    return owner.epoch === epoch && owner.workspace === options.workspace() && owner.generation === options.generation();
  }
  function assertCurrent(owner: Owner, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!current(owner)) throw new DOMException("The Wiki settings request no longer owns this project.", "AbortError");
  }
  function sameOwner(left: Owner, right: Owner): boolean {
    return left.workspace === right.workspace && left.generation === right.generation && left.epoch === right.epoch;
  }

  async function persist(workspace: string, edit: WorkspaceConfigEdit, label: string): Promise<void> {
    let failed = false, failure: unknown;
    await persistWorkspaceConfigEdit(workspace, edit, label, cause => { failed = true; failure = cause; });
    if (failed) throw failure;
  }

  function initialize(owner: Owner, signal: AbortSignal): Promise<void> {
    if (initialization && sameOwner(initialization.owner, owner)) return initialization.pending;
    const pending = (async () => {
      let runId: string | undefined;
      try {
        await persist(owner.workspace, source => {
          assertCurrent(owner, signal);
          getProjectWikiConfig(source);
          const latest = getWikiAutoCheckSettings(source);
          // Throwing here avoids even an unchanged native write when a concurrent
          // writer disabled checking, removed the config, or already supplied an ID.
          if (!latest.enabled || latest.runId) throw new InitializationAlreadyResolved();
          runId ??= globalThis.crypto.randomUUID();
          return editWikiAutoCheckSettings(source, true, runId);
        }, "Wiki background check identity");
      } catch (cause) {
        if (!(cause instanceof InitializationAlreadyResolved)) throw cause;
      }
    })();
    const entry = { owner, pending };
    initialization = entry;
    const clear = () => { if (initialization === entry) initialization = undefined; };
    void pending.then(clear, clear);
    return pending;
  }

  async function read(workspace: string, signal: AbortSignal): Promise<WikiAutoCheckConfiguration> {
    const owner = capture(workspace);
    assertCurrent(owner, signal);
    let document = await readWorkspaceConfig(workspace);
    assertCurrent(owner, signal);
    let setting = getWikiAutoCheckSettings(document?.content);
    persistedEnabled = setting.enabled;
    let wiki = getProjectWikiConfig(document?.content);
    if (setting.enabled && !setting.runId) {
      await initialize(owner, signal);
      assertCurrent(owner, signal);
      document = await readWorkspaceConfig(workspace);
      assertCurrent(owner, signal);
      setting = getWikiAutoCheckSettings(document?.content);
      persistedEnabled = setting.enabled;
      wiki = getProjectWikiConfig(document?.content);
      if (setting.enabled && !setting.runId) throw new Error("The Wiki background pass identity could not be saved.");
    }
    if (!setting.enabled) return { enabled: false, wikiPath: wiki.path, runId: setting.runId, sourcesEnabled: false };
    const policy = await readSearchSourceSelection(workspace, signal);
    assertCurrent(owner, signal);
    if (policy.error) throw new Error(policy.error);
    return { enabled: true, wikiPath: wiki.path, runId: setting.runId, sourcesEnabled: policy.enabled.knowledge === true };
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    const workspace = options.workspace();
    if (!workspace || (saving && mutation && current(mutation))) return;
    epoch++;
    const owner = capture(workspace);
    mutation = owner;
    saving = true;
    error = undefined;
    try {
      // Invalidate scheduled reads and waiting background jobs before queueing a CAS edit.
      options.pause();
      const runId = enabled ? globalThis.crypto.randomUUID() : undefined;
      // An explicit user choice retains its original target even after navigation.
      await persist(workspace, source => editWikiAutoCheckSettings(source, enabled, runId), "Wiki background checking");
    } catch (cause) {
      if (current(owner)) error = message(cause);
      try { options.reportError(cause, workspace); } catch { /* Diagnostics cannot own the toggle lifecycle. */ }
    } finally {
      if (current(owner)) {
        saving = false;
        mutation = undefined;
        try { options.resume(); }
        catch (cause) {
          if (current(owner)) error = message(cause);
          try { options.reportError(cause, workspace); } catch { /* Keep failures inside the owner. */ }
        }
      }
    }
  }

  function reset(): void {
    epoch++;
    saving = false;
    error = undefined;
    persistedEnabled = undefined;
    mutation = undefined;
    initialization = undefined;
  }

  return {
    get enabled() { return persistedEnabled; },
    get saving() { return saving; },
    get error() { return error; },
    read, setEnabled, reset,
  };
}
