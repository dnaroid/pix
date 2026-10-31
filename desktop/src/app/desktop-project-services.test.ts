import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopProjectServices } from "./desktop-project-services";
import type { ProjectFilePreview } from "../lib/project-files";
import type { ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";

const mocks = vi.hoisted(() => ({
  documentOptions: undefined as Record<string, any> | undefined,
  active: undefined as { id: number; kind: "file"; file: ProjectFilePreview } | undefined,
  generation: 0,
  diagnosticContext: undefined as (() => { workspace: string }) | undefined,
  diagnostic: vi.fn(),
  replaceCurrentFile: vi.fn(), openProjectFile: vi.fn(),
  success: vi.fn(), warning: vi.fn(), error: vi.fn(),
}));

vi.mock("./preview.svelte", () => ({ createPreviewStore: () => ({
  get active() { return mocks.active; },
  replaceCurrentFile: mocks.replaceCurrentFile, openProjectFile: mocks.openProjectFile,
}) }));
vi.mock("./project-documents.svelte", () => ({ createProjectDocumentsStore: (options: Record<string, any>) => {
  mocks.documentOptions = options;
  return { get generation() { return mocks.generation; } };
} }));
vi.mock("../lib/diagnostic-logging", () => ({ createDiagnosticLogger: (context: () => { workspace: string }) => {
  mocks.diagnosticContext = context;
  return { report: mocks.diagnostic, warn: mocks.diagnostic };
} }));
vi.mock("./project-tasks.svelte", () => ({ createProjectTasksStore: () => ({}) }));
vi.mock("./project-workspace.svelte", () => ({ createProjectWorkspaceStore: () => ({}) }));
vi.mock("./registry.svelte", () => ({ createRegistryStore: () => ({ scheduleProjectSync: vi.fn() }) }));
vi.mock("./git-ci.svelte", () => ({ createGitCiStore: () => ({}) }));
vi.mock("./git-workspace.svelte", () => ({ createGitWorkspaceStore: () => ({}) }));
vi.mock("./plan-launches.svelte", () => ({ createPlanLaunchesStore: () => ({}) }));
vi.mock("./toasts.svelte", () => ({ toasts: { success: mocks.success, warning: mocks.warning, error: mocks.error } }));

function fixture() {
  let workspace = "/project";
  let client: any = null;
  const reportError = vi.fn(), openKnowledgeChecks = vi.fn();
  createDesktopProjectServices({
    client: () => client, workspace: () => workspace, operationRunning: () => false,
    sessionWorkspace: () => undefined, transcript: () => ({ items: [] }) as any,
    prepareAttachment: async () => {}, activeWorkbenchTabId: () => null,
    activeConversationWorkbenchTabId: () => null, setActiveWorkbenchTabId: vi.fn(),
    nextWorkbenchAuxOrder: () => 1, setErrorMessage: vi.fn(), clearError: vi.fn(), reportError, openKnowledgeChecks,
  });
  return {
    reportError, openKnowledgeChecks,
    afterSave: mocks.documentOptions!.afterSave as (file: ProjectFilePreview, workspace: string, previewId?: number) => void,
    complete: mocks.documentOptions!.onKnowledgeJobComplete as (job: ProjectKnowledgeJob) => Promise<void>,
    ready: mocks.documentOptions!.knowledgeBackgroundReady as () => boolean,
    backgroundError: mocks.documentOptions!.reportBackgroundKnowledgeError as (error: unknown) => void,
    connect: () => { client = { checkKnowledge: vi.fn() }; },
    switchWorkspace: (next = "/other") => { workspace = next; mocks.generation++; },
  };
}

function completedJob(): ProjectKnowledgeJob {
  return {
    id: 4, workspace: "/project", path: "wiki/checked.md", content: "Body", expectedContent: "Body",
    persistStamp: true, state: "completed", createdAt: 1, finishedAt: 2, recorded: true,
    result: { status: "clear", path: "wiki/checked.md", documentHash: "a".repeat(64), modelRef: "test/model",
      checkedSources: 1, conflicts: [], notices: [], reportLanguage: "ru" },
  };
}

function conflictJob(): ProjectKnowledgeJob {
  const job = completedJob();
  return { ...job, result: { ...job.result!, status: "conflicts", conflicts: [{
    draft: { path: job.path, quote: "Body", startLine: 1, endLine: 1 },
    existing: { path: "wiki/rules.md", quote: "Other", startLine: 1, endLine: 1 },
    explanation: "The rules differ.",
  }] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.active = undefined;
  mocks.documentOptions = undefined;
  mocks.generation = 0;
  mocks.diagnosticContext = undefined;
});

describe("background Wiki check workbench integration", () => {
  it("does not replace a different page even when a background write captured its current Preview id", () => {
    const { afterSave } = fixture();
    const saved = { path: "wiki/checked.md", content: "Body with stamp" };
    afterSave(saved, "/project", undefined);
    expect(mocks.replaceCurrentFile).not.toHaveBeenCalled();
    mocks.active = { id: 9, kind: "file", file: { path: "wiki/other.md", content: "Other" } };
    afterSave(saved, "/project", 9);
    expect(mocks.replaceCurrentFile).not.toHaveBeenCalled();
    mocks.active = { id: 10, kind: "file", file: { path: saved.path, content: "Body" } };
    afterSave(saved, "/project", 9);
    afterSave(saved, "/other", 10);
    expect(mocks.replaceCurrentFile).not.toHaveBeenCalled();
    afterSave(saved, "/project", 10);
    expect(mocks.replaceCurrentFile).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("notifies conflicts in red and fences page/list actions across a project round-trip", async () => {
    const item = fixture();
    await item.complete(conflictJob());
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
    const notification = mocks.error.mock.calls[0]![0];
    expect(notification.message).toMatch(/В Wiki найдены возможные противоречия/u);
    expect(notification.log).toBe(false);
    await notification.actions[0].run();
    await notification.actions[1].run();
    expect(mocks.openProjectFile).toHaveBeenCalledExactlyOnceWith("wiki/checked.md", "push", undefined, false, "document");
    expect(item.openKnowledgeChecks).toHaveBeenCalledOnce();
    item.switchWorkspace();
    item.switchWorkspace("/project");
    await notification.actions[0].run();
    await notification.actions[1].run();
    expect(mocks.openProjectFile).toHaveBeenCalledOnce();
    expect(item.openKnowledgeChecks).toHaveBeenCalledOnce();
  });

  it("keeps successful, incomplete, failed and persistence-only outcomes silent", async () => {
    const item = fixture();
    const clear = completedJob();
    await item.complete(clear);
    await item.complete({ ...clear, recorded: false, error: "File changed on disk" });
    await item.complete({ ...clear, result: { ...clear.result!, status: "incomplete" } });
    await item.complete({ ...clear, state: "failed", result: undefined, error: "Provider failed" });
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("defers background checks until a client exists and logs operational failures quietly", () => {
    const item = fixture();
    expect(item.ready()).toBe(false);
    item.connect();
    expect(item.ready()).toBe(true);
    const failure = new Error("Background discovery failed");
    item.backgroundError(failure);
    expect(mocks.diagnostic).toHaveBeenCalledExactlyOnceWith("wiki:background-check", failure);
    expect(mocks.diagnosticContext?.()).toEqual({ workspace: "/project" });
    expect(item.reportError).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
