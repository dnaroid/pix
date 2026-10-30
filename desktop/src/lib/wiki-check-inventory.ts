import { invoke } from "@tauri-apps/api/core";
import { createDiagnosticLogger } from "./diagnostic-logging";
import type { ProjectFilePreview } from "./project-files";

export type WikiCheckInventoryEntry =
  | { readonly path: string; readonly kind: "directory" }
  | { readonly path: string; readonly kind: "file"; readonly revision: string; readonly size: number };

export interface WikiCheckDirectoryPage {
  readonly entries: readonly WikiCheckInventoryEntry[];
  /** A page can be empty but still have a continuation; each token is single-use. */
  readonly nextCursor?: string;
}

export interface WikiCheckInventoryRequest {
  readonly workspace: string;
  readonly wikiPath: string;
  readonly path: string;
  readonly cursor?: string;
}

async function releaseAfterAbandonment(workspace: string, cursor: string): Promise<void> {
  try { await releaseWikiCheckInventory(workspace, cursor); }
  catch (error) {
    createDiagnosticLogger(() => ({ workspace })).report(error, "wiki:inventory-release-failed");
  }
}

/** Filesystem traversal stays on the native blocking worker. No Markdown body enters this response. */
export function listWikiCheckDirectory(
  request: WikiCheckInventoryRequest,
  signal: AbortSignal,
): Promise<WikiCheckDirectoryPage> {
  return listDirectory("list_wiki_check_directory", request, signal);
}

/** Status-only traversal also counts hidden/generated Markdown visible in the Wiki tree. */
export function listWikiStatusDirectory(
  request: WikiCheckInventoryRequest,
  signal: AbortSignal,
): Promise<WikiCheckDirectoryPage> {
  return listDirectory("list_wiki_status_directory", request, signal);
}

async function listDirectory(
  command: "list_wiki_check_directory" | "list_wiki_status_directory",
  request: WikiCheckInventoryRequest,
  signal: AbortSignal,
): Promise<WikiCheckDirectoryPage> {
  if (signal.aborted) {
    if (request.cursor) await releaseAfterAbandonment(request.workspace, request.cursor);
    signal.throwIfAborted();
  }
  let page: WikiCheckDirectoryPage;
  try { page = await invoke<WikiCheckDirectoryPage>(command, { ...request }); }
  catch (error) {
    // A failed containment inspection can reject before the native iterator is consumed.
    if (request.cursor) await releaseAfterAbandonment(request.workspace, request.cursor);
    throw error;
  }
  if (signal.aborted) {
    if (page.nextCursor) await releaseAfterAbandonment(request.workspace, page.nextCursor);
    signal.throwIfAborted();
  }
  return page;
}

export function releaseWikiCheckInventory(workspace: string, cursor: string): Promise<void> {
  return invoke<void>("release_wiki_check_inventory", { workspace, cursor });
}

/** Revalidate containment and every symlink ancestor at read time, independently of inventory. */
export function readWikiCheckDocument(
  workspace: string,
  wikiPath: string,
  path: string,
  signal: AbortSignal,
): Promise<ProjectFilePreview> {
  return readDocument("read_wiki_check_document", workspace, wikiPath, path, signal);
}

/** Reads saved status metadata without changing automatic-check eligibility or invoking a model. */
export function readWikiStatusDocument(
  workspace: string,
  wikiPath: string,
  path: string,
  signal: AbortSignal,
): Promise<ProjectFilePreview> {
  return readDocument("read_wiki_status_document", workspace, wikiPath, path, signal);
}

async function readDocument(
  command: "read_wiki_check_document" | "read_wiki_status_document",
  workspace: string,
  wikiPath: string,
  path: string,
  signal: AbortSignal,
): Promise<ProjectFilePreview> {
  signal.throwIfAborted();
  const document = await invoke<ProjectFilePreview>(command, { workspace, wikiPath, path });
  signal.throwIfAborted();
  if (document.path !== path) throw new Error("The Wiki inventory reader returned another document.");
  return document;
}
