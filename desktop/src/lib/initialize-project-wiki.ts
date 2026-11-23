import { invoke } from "@tauri-apps/api/core";
import type { ProjectWikiConfig } from "./project-wiki";

/** A Wiki holding only this page is still considered empty. */
export const STARTER_WIKI_INDEX = "# Project wiki\n\nDescribe the project, its requirements and rules here.\n\n## Contents\n\nCreate pages and sections in the Wiki sidebar, then link them from this index.\n";

export async function initializeProjectWiki(
  workspace: string,
  config: ProjectWikiConfig,
  assertCurrent: () => void,
  send: <T>(command: string, args: Record<string, unknown>) => Promise<T> = invoke,
): Promise<void> {
  const directory = config.indexPath.slice(0, config.indexPath.lastIndexOf("/"));
  let parent = "";
  for (const name of directory.split("/")) {
    const path = parent ? `${parent}/${name}` : name;
    const exists = await send<boolean>("project_directory_exists", { workspace, path });
    assertCurrent();
    if (!exists) {
      await send("create_project_entry", { workspace, parent: parent || null, name, kind: "directory" });
      assertCurrent();
    }
    parent = path;
  }
  const indexExists = await send<boolean>("project_file_exists", { workspace, path: config.indexPath });
  assertCurrent();
  if (!indexExists) {
    await send("create_project_entry", {
      workspace, parent, name: config.indexPath.slice(parent.length + 1), kind: "file",
      initialContent: STARTER_WIKI_INDEX,
    });
    assertCurrent();
  }
}
