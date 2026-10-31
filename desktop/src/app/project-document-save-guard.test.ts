import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import { EMPTY_PROJECT_DOCUMENTS } from "../lib/project-documents";
import type { ProjectFilePreview } from "../lib/project-files";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readWorkspaceConfig: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./workspace-config-persistence", () => ({ readWorkspaceConfig: mocks.readWorkspaceConfig }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = () => yes(); });
  return { promise, resolve };
}

const path = "wiki/page.md";
const rawBaseline = 'Body B\n<!-- pix:wiki-check previous saved metadata -->\n';
const checkedBody = 'Body B\n<!-- pix:wiki-check replacement metadata -->\n';

function fixture() {
  let workspace = "/project";
  let file: ProjectFilePreview = { path, content: rawBaseline };
  let disk = rawBaseline;
  const firstWrite = deferred();
  const requests: { content: string; expectedContent?: string }[] = [];
  mocks.invoke.mockImplementation((command: string, args: { path: string; content: string; expectedContent?: string }) => {
    if (command === "list_project_documents") return Promise.resolve(EMPTY_PROJECT_DOCUMENTS);
    if (command !== "write_project_file") throw new Error(`Unexpected command: ${command}`);
    requests.push(args);
    const commit = () => {
      if (args.expectedContent !== disk) throw new Error("File changed while editing");
      disk = args.content;
      return { path: args.path, content: args.content };
    };
    return requests.length === 1 ? firstWrite.promise.then(commit) : Promise.resolve().then(commit);
  });
  const afterSave = vi.fn((saved: ProjectFilePreview) => { file = saved; });
  const reportError = vi.fn();
  const store = createProjectDocumentsStore({
    workspace: () => workspace, currentFile: () => file, previewId: () => 7,
    openProjectFile: vi.fn(), showEmptyFile: vi.fn(), afterSave,
    clearError: vi.fn(), reportError,
  });
  return { store, firstWrite, requests, afterSave, reportError, disk: () => disk, loaded: () => file.content,
    changeWorkspace: () => { workspace = "/other-project"; } };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.readWorkspaceConfig.mockReset().mockResolvedValue(null);
});

describe("strict queued project-file saves", () => {
  it("does not rebase reviewed metadata onto a preceding write's changed body", async () => {
    const item = fixture();
    const first = item.store.save(path, "Body A");
    await vi.waitFor(() => expect(item.requests).toHaveLength(1));
    const metadata = item.store.save(path, checkedBody, { expectedContent: rawBaseline, isCurrent: () => true });
    expect(item.requests).toHaveLength(1);
    item.firstWrite.resolve();
    expect(await first).toBe(true);
    expect(await metadata).toBe(false);
    expect(item.requests).toHaveLength(2);
    expect(item.requests[1]?.expectedContent).toBe(rawBaseline);
    expect(item.disk()).toBe("Body A");
    expect(item.afterSave).toHaveBeenCalledTimes(1);
    expect(item.reportError).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "workspace"] as const)("does not invoke a queued metadata write after its %s becomes stale", async invalidation => {
    const item = fixture();
    let current = true;
    const first = item.store.save(path, "Body A");
    await vi.waitFor(() => expect(item.requests).toHaveLength(1));
    const metadata = item.store.save(path, checkedBody, { expectedContent: rawBaseline, isCurrent: () => current });
    if (invalidation === "owner") current = false;
    else item.changeWorkspace();
    item.firstWrite.resolve();
    await first;
    expect(await metadata).toBe(false);
    expect(item.requests).toHaveLength(1);
    expect(item.disk()).toBe("Body A");
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("retains ordinary unguarded save sequencing and the previous committed baseline", async () => {
    const item = fixture();
    const first = item.store.save(path, "Body A");
    await vi.waitFor(() => expect(item.requests).toHaveLength(1));
    const next = item.store.save(path, "User's newer draft");
    item.firstWrite.resolve();
    expect(await first).toBe(true);
    expect(await next).toBe(true);
    expect(item.requests).toHaveLength(2);
    expect(item.requests[1]?.expectedContent).toBe("Body A");
    expect(item.disk()).toBe("User's newer draft");
    expect(item.afterSave).toHaveBeenCalledTimes(2);
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("publishes an already committed baseline when editing invalidates the guard after native invocation", async () => {
    const item = fixture();
    let current = true;
    const saving = item.store.save(path, checkedBody, { expectedContent: rawBaseline, isCurrent: () => current });
    await vi.waitFor(() => expect(item.requests).toHaveLength(1));
    current = false;
    item.firstWrite.resolve();
    expect(await saving).toBe(true);
    expect(item.disk()).toBe(checkedBody);
    expect(item.loaded()).toBe(checkedBody);
    expect(item.afterSave).toHaveBeenCalledExactlyOnceWith({ path, content: checkedBody }, "/project", 7);
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("keeps the previous committed baseline through a canceled metadata queue entry", async () => {
    const item = fixture();
    let current = true;
    const first = item.store.save(path, "Body A");
    await vi.waitFor(() => expect(item.requests).toHaveLength(1));
    const metadata = item.store.save(path, checkedBody, { expectedContent: rawBaseline, isCurrent: () => current });
    const next = item.store.save(path, "User's newer draft");
    current = false;
    item.firstWrite.resolve();
    expect(await first).toBe(true);
    expect(await metadata).toBe(false);
    expect(await next).toBe(true);
    expect(item.requests).toHaveLength(2);
    expect(item.requests[1]?.expectedContent).toBe("Body A");
    expect(item.disk()).toBe("User's newer draft");
    expect(item.afterSave).toHaveBeenCalledTimes(2);
    expect(item.reportError).not.toHaveBeenCalled();
  });
});
