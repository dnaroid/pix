import { invoke } from "@tauri-apps/api/core";
import type { ProjectFilePreview } from "../lib/project-files";
import type { ProjectTreeEntry } from "../lib/project-tree";
import { getProjectWikiConfig } from "../lib/project-wiki";
import { createWikiContents } from "../lib/project-wiki-contents";
import { wikiFolderIndexCandidates } from "../lib/project-wiki-navigation";
import { readWorkspaceConfig } from "./workspace-config-persistence";

type WikiDirectoryTarget = { kind: "index"; path: string } | { kind: "contents"; file: ProjectFilePreview };

/** Outside Wiki, callers retain normal Files reveal behavior. Never writes a file. */
export async function resolvePreviewWikiDirectory(
  workspace: string, path: string, isCurrent: () => boolean,
): Promise<WikiDirectoryTarget | undefined> {
  const document = await readWorkspaceConfig(workspace);
  if (!isCurrent()) return;
  const config = getProjectWikiConfig(document?.content);
  if (path !== config.path && !path.startsWith(`${config.path}/`)) return;
  const directory = path === config.path ? "" : path.slice(config.path.length + 1);
  for (const index of wikiFolderIndexCandidates(directory, config)) {
    const target = `${config.path}/${index}`;
    const exists = await invoke<boolean>("project_file_exists", { workspace, path: target });
    if (!isCurrent()) return;
    if (exists) return { kind: "index", path: target };
  }
  const entries = await invoke<ProjectTreeEntry[]>("list_project_directory", { workspace, path });
  if (!isCurrent()) return;
  return { kind: "contents", file: createWikiContents(path, entries) };
}
