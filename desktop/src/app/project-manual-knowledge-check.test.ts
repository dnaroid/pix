import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import { EMPTY_PROJECT_DOCUMENTS } from "../lib/project-documents";
import type { ProjectFilePreview } from "../lib/project-files";
import type { KnowledgeCheckRequest, KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { readKnowledgeCheckStamp, readKnowledgeReport, recordKnowledgeCheck, stampKnowledgeCheck, stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readWorkspaceConfig: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./workspace-config-persistence", () => ({ readWorkspaceConfig: mocks.readWorkspaceConfig }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function result(path: string, content: string, status: "clear" | "incomplete" = "clear"): Promise<KnowledgeCheckResult> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return { status, path, documentHash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    modelRef: "test/model", checkedSources: 1, conflicts: [], notices: status === "incomplete" ? ["Evidence was incomplete."] : [] };
}

const path = "wiki/page.md";

function fixture(content = "Saved body") {
  let workspace = "/project", previewId = 1;
  let file: ProjectFilePreview = { path, content };
  const disk = new Map([[path, content], ["wiki/other.md", "Other page"]]);
  const checkKnowledge = vi.fn(async (request: KnowledgeCheckRequest, _signal: AbortSignal) => result(request.path, request.content));
  const afterSave = vi.fn((saved: ProjectFilePreview, _workspace: string, owner: number | undefined) => {
    if (previewId === owner && file.path === saved.path) file = saved;
  });
  const reportError = vi.fn(), onKnowledgeJobComplete = vi.fn();
  mocks.invoke.mockImplementation(async (command: string, args: { path?: string; content?: string; expectedContent?: string }) => {
    if (command === "list_project_documents") return EMPTY_PROJECT_DOCUMENTS;
    if (command !== "write_project_file") throw new Error(`Unexpected command: ${command}`);
    if (disk.get(args.path!) !== args.expectedContent) throw new Error("File changed while editing");
    disk.set(args.path!, args.content!);
    return { path: args.path!, content: args.content! };
  });
  const store = createProjectDocumentsStore({
    workspace: () => workspace, previewId: () => previewId, currentFile: () => file,
    openProjectFile: vi.fn(), showEmptyFile: vi.fn(), afterSave, clearError: vi.fn(), reportError,
    checkKnowledge, onKnowledgeJobComplete,
  });
  return { store, disk, checkKnowledge, reportError, afterSave, onKnowledgeJobComplete,
    current: () => file,
    navigate: (target = "wiki/other.md") => { previewId++; file = { path: target, content: disk.get(target)! }; },
    changeWorkspace: () => { workspace = "/other-project"; },
    enqueue: (draft = stripKnowledgeCheckStamp(content), persistStamp = true) => store.enqueueKnowledgeCheck({ path, content: draft, expectedContent: content, persistStamp })!,
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.readWorkspaceConfig.mockReset().mockResolvedValue(null);
});

describe("manual Wiki checks through the project documents store", () => {
  it("keeps the captured raw baseline through config loading and page navigation", async () => {
    const item = fixture(), config = deferred<null>(), backend = deferred<KnowledgeCheckResult>();
    mocks.readWorkspaceConfig.mockReturnValueOnce(config.promise);
    item.checkKnowledge.mockReturnValueOnce(backend.promise);
    const id = item.enqueue();
    await vi.waitFor(() => expect(mocks.readWorkspaceConfig).toHaveBeenCalledTimes(1));
    item.navigate();
    config.resolve(null);
    await vi.waitFor(() => expect(item.checkKnowledge).toHaveBeenCalledTimes(1));
    expect(item.checkKnowledge.mock.calls[0]?.[0]).toEqual({ cwd: "/project", path, content: "Saved body", expectedContent: "Saved body" });
    expect(item.checkKnowledge.mock.calls[0]?.[1].aborted).toBe(false);
    backend.resolve(await result(path, "Saved body"));
    await vi.waitFor(() => expect(item.store.knowledgeJobs.find(job => job.id === id)?.state).toBe("completed"));
    expect(item.store.knowledgeJobs[0]?.recorded).toBe(true);
    expect(await readKnowledgeCheckStamp(item.disk.get(path)!)).toBeDefined();
    expect(item.current()).toEqual({ path: "wiki/other.md", content: "Other page" });
    expect(item.onKnowledgeJobComplete).toHaveBeenCalledTimes(1);
    item.navigate(path);
    expect(item.store.getKnowledgeJob(path, stripKnowledgeCheckStamp(item.current().content))?.id).toBe(id);
  });

  it("retains a manual draft report after navigation without saving the draft or marker", async () => {
    const item = fixture(), backend = deferred<KnowledgeCheckResult>();
    item.checkKnowledge.mockReturnValueOnce(backend.promise);
    const id = item.enqueue("Unsaved changes", false);
    await vi.waitFor(() => expect(item.checkKnowledge).toHaveBeenCalledTimes(1));
    item.navigate();
    backend.resolve(await result(path, "Unsaved changes"));
    await vi.waitFor(() => expect(item.store.knowledgeJobs.find(job => job.id === id)?.state).toBe("completed"));
    expect(item.disk.get(path)).toBe("Saved body");
    expect(item.afterSave).not.toHaveBeenCalled();
    expect(item.store.getKnowledgeJob(path, "Unsaved changes")?.result?.status).toBe("clear");
    expect(item.store.getKnowledgeJob(path, "Saved body")).toBeUndefined();
  });

  it("keeps the report but refuses to stamp a file changed while the model was working", async () => {
    const item = fixture(), backend = deferred<KnowledgeCheckResult>();
    item.checkKnowledge.mockReturnValueOnce(backend.promise);
    item.enqueue();
    await vi.waitFor(() => expect(item.checkKnowledge).toHaveBeenCalledTimes(1));
    item.disk.set(path, "External edit");
    backend.resolve(await result(path, "Saved body"));
    await vi.waitFor(() => expect(item.store.knowledgeJobs[0]?.state).toBe("completed"));
    expect(item.store.knowledgeJobs[0]).toMatchObject({ recorded: false, result: { status: "clear" } });
    expect(item.store.knowledgeJobs[0]?.error).toBeTruthy();
    expect(item.disk.get(path)).toBe("External edit");
    expect(item.afterSave).not.toHaveBeenCalled();
    expect(item.reportError).toHaveBeenCalledTimes(1);
  });

  it("removes an obsolete success marker after a completed nonclear saved-page check", async () => {
    const raw = await stampKnowledgeCheck("Saved body", await result(path, "Saved body"));
    const item = fixture(raw);
    item.checkKnowledge.mockResolvedValueOnce(await result(path, "Saved body", "incomplete"));
    item.enqueue();
    await vi.waitFor(() => expect(item.store.knowledgeJobs[0]?.state).toBe("completed"));
    const saved = item.disk.get(path)!;
    expect(stripKnowledgeCheckStamp(saved)).toBe("Saved body");
    expect(await readKnowledgeCheckStamp(saved)).toBeUndefined();
    expect(await readKnowledgeReport(saved)).toMatchObject({ current: true, result: { status: "incomplete", path } });
    expect(item.store.knowledgeJobs[0]).toMatchObject({ recorded: true, result: { status: "incomplete" } });
    expect(item.checkKnowledge.mock.calls[0]?.[0].expectedContent).toBe(raw);
  });

  it("removes a persisted report only after a new clear check of the same saved body", async () => {
    const report = await result(path, "Saved body", "incomplete");
    const raw = await recordKnowledgeCheck("Saved body", report);
    const item = fixture(raw);
    item.enqueue();
    await vi.waitFor(() => expect(item.store.knowledgeJobs[0]?.state).toBe("completed"));
    const saved = item.disk.get(path)!;
    expect(stripKnowledgeCheckStamp(saved)).toBe("Saved body");
    expect(await readKnowledgeReport(saved)).toBeUndefined();
    expect(saved).not.toContain("pix:wiki-report");
    expect(await readKnowledgeCheckStamp(saved)).toBeDefined();
    expect(item.checkKnowledge.mock.calls[0]?.[0]).toMatchObject({ content: "Saved body", expectedContent: raw });
  });

  it("replaces one nonclear report after restart without changing the captured body", async () => {
    const previous = await result(path, "Saved body", "incomplete");
    const raw = await recordKnowledgeCheck("Saved body", previous, "2026-01-01T00:00:00.000Z");
    const next = { ...previous, modelRef: "test/new-judge", notices: ["Updated missing condition."] };
    const item = fixture(raw);
    item.checkKnowledge.mockResolvedValueOnce(next);
    item.enqueue();
    await vi.waitFor(() => expect(item.store.knowledgeJobs[0]?.state).toBe("completed"));
    const saved = item.disk.get(path)!;
    expect(stripKnowledgeCheckStamp(saved)).toBe("Saved body");
    expect((saved.match(/<!-- pix:wiki-report /g) ?? [])).toHaveLength(1);
    expect(await readKnowledgeReport(saved)).toMatchObject({ current: true, result: next });
    expect(item.checkKnowledge.mock.calls[0]?.[0].expectedContent).toBe(raw);
  });

  it("admits a saved report larger than the old stamp budget without sending it to the judge", async () => {
    const body = "Saved body\n".repeat(1000);
    const report = { ...await result(path, body, "incomplete"), reviewedSources: [
      { path: "wiki/source.md", quote: "Evidence ".repeat(5000), startLine: 1, endLine: 1 },
    ] };
    const raw = await recordKnowledgeCheck(body, report);
    expect(raw.length).toBeGreaterThan(52_096);
    const item = fixture(raw);
    expect(item.enqueue()).toBeDefined();
    await vi.waitFor(() => expect(item.store.knowledgeJobs[0]?.state).toBe("completed"));
    expect(item.checkKnowledge.mock.calls[0]?.[0]).toMatchObject({ content: body, expectedContent: raw });
    expect(await readKnowledgeReport(item.disk.get(path)!)).toBeUndefined();
    expect(await readKnowledgeCheckStamp(item.disk.get(path)!)).toBeDefined();
  });

  it("preserves an externally edited body when a nonclear report finishes in the background", async () => {
    const raw = await recordKnowledgeCheck("Saved body", await result(path, "Saved body", "incomplete"));
    const item = fixture(raw), backend = deferred<KnowledgeCheckResult>();
    item.checkKnowledge.mockReturnValueOnce(backend.promise);
    item.enqueue();
    await vi.waitFor(() => expect(item.checkKnowledge).toHaveBeenCalledOnce());
    item.disk.set(path, raw.replace("Saved body", "Externally edited body"));
    backend.resolve(await result(path, "Saved body", "incomplete"));
    await vi.waitFor(() => expect(item.store.knowledgeJobs[0]?.state).toBe("completed"));
    expect(item.store.knowledgeJobs[0]?.recorded).toBe(false);
    expect(stripKnowledgeCheckStamp(item.disk.get(path)!)).toBe("Externally edited body");
    expect(item.afterSave).not.toHaveBeenCalled();
  });

  it("preserves the previous marker when no completed model result exists", async () => {
    const raw = await stampKnowledgeCheck("Saved body", await result(path, "Saved body"));
    const item = fixture(raw);
    item.checkKnowledge.mockRejectedValueOnce(new Error("Disconnected"));
    item.enqueue();
    await vi.waitFor(() => expect(item.store.knowledgeJobs[0]?.state).toBe("failed"));
    expect(item.disk.get(path)).toBe(raw);
    expect(item.afterSave).not.toHaveBeenCalled();
    expect(item.onKnowledgeJobComplete).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight check on project reset without late writes or notifications", async () => {
    const item = fixture(), backend = deferred<KnowledgeCheckResult>();
    item.checkKnowledge.mockReturnValueOnce(backend.promise);
    item.enqueue();
    await vi.waitFor(() => expect(item.checkKnowledge).toHaveBeenCalledTimes(1));
    item.store.reset();
    item.changeWorkspace();
    expect(item.checkKnowledge.mock.calls[0]?.[1].aborted).toBe(true);
    backend.resolve(await result(path, "Saved body"));
    await backend.promise;
    await Promise.resolve();
    expect(item.store.knowledgeJobs).toEqual([]);
    expect(item.afterSave).not.toHaveBeenCalled();
    expect(item.onKnowledgeJobComplete).not.toHaveBeenCalled();
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("rereads the Wiki path when a waiting check starts and reports an excluded snapshot", async () => {
    const item = fixture();
    mocks.readWorkspaceConfig.mockResolvedValue({ content: JSON.stringify({ wiki: { path: "docs/reference" } }) });
    item.enqueue();
    await vi.waitFor(() => expect(item.store.knowledgeJobs[0]?.state).toBe("failed"));
    expect(item.store.knowledgeJobs[0]?.error).toMatch(/configured Wiki/);
    expect(item.checkKnowledge).not.toHaveBeenCalled();
    expect(item.afterSave).not.toHaveBeenCalled();
  });
});
