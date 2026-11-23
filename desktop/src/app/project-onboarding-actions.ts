import { invoke } from "@tauri-apps/api/core";
import type { AcpClient } from "../lib/acp-client";
import { initializeProjectWiki } from "../lib/initialize-project-wiki";
import type { ProjectIconImage } from "../lib/project-icon";
import { isOnboardingResource, type ProjectOnboardingActions } from "../lib/project-onboarding";
import { getProjectWikiConfig } from "../lib/project-wiki";
import { setSearchSourceSelection } from "../lib/search-source-selection";
import { editWikiAutoCheckSettings } from "../lib/wiki-auto-check-config";
import { persistWorkspaceConfigEdit, readWorkspaceConfig } from "./workspace-config-persistence";

export async function loadOnboardingResources(workspace: string, client: AcpClient, signal: AbortSignal) {
  const snapshot = await client.registryAction(workspace, { action: "refresh" }, signal);
  if (snapshot.error) throw new Error(snapshot.error);
  return { configured: snapshot.configured, resources: snapshot.items.filter(isOnboardingResource) };
}

export function createProjectOnboardingActions(options: {
  workspace: string;
  client: () => AcpClient | null;
  generateIcon: (prompt?: string) => Promise<ProjectIconImage>;
  saveIcon: (image: ProjectIconImage) => Promise<void>;
}): ProjectOnboardingActions {
  const { workspace } = options;
  let generatedIcon: ProjectIconImage | undefined;
  return {
    git: () => invoke("git_initialize", { workspace, ensureIgnores: true }),
    async wiki(signal) {
      const config = getProjectWikiConfig((await readWorkspaceConfig(workspace))?.content);
      signal.throwIfAborted();
      await initializeProjectWiki(workspace, config, () => signal.throwIfAborted());
    },
    async knowledge(signal) {
      await setSearchSourceSelection(workspace, "knowledge", true, signal);
    },
    async autoCheck(signal) {
      const runId = crypto.randomUUID();
      let failure: { error: unknown } | undefined;
      await persistWorkspaceConfigEdit(workspace, source => {
        signal.throwIfAborted();
        return editWikiAutoCheckSettings(source, true, runId);
      }, "Wiki background checking", error => { failure = { error }; });
      if (failure) throw failure.error;
    },
    async install(resource, signal) {
      const client = options.client();
      if (!client) throw new Error("Connect the project backend before installing registry resources.");
      const result = await client.registryAction(workspace, { action: "install-global", type: resource.type, name: resource.name }, signal);
      if (result.error) throw new Error(result.error);
      if (!result.items.some(item => item.type === resource.type && item.name === resource.name && item.local)) {
        throw new Error("The project copy could not be verified in Registry.");
      }
    },
    async icon(icon, signal) {
      const image = icon.kind === "file" ? icon.image : (generatedIcon ??= await options.generateIcon(icon.prompt));
      signal.throwIfAborted();
      await options.saveIcon(image);
    },
  };
}
