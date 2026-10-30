import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopProjectServices } from "./desktop-project-services";
import type { ProjectFilePreview } from "../lib/project-files";
import type { ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";

const mocks = vi.hoisted(() => ({
  documentOptions: undefined as Record<string, any> | undefined,
  active: undefined as { id: number; kind: "file"; file: ProjectFilePreview } | undefined,
  replaceCurrentFile: vi.fn(), openProjectFile: vi.fn(),
  success: vi.fn(), warning: vi.fn(), error: vi.fn(),
}));

vi.mock("./preview.svelte", () => ({ createPreviewStore: () => ({
  get active() { return mocks.active; },
  replaceCurrentFile: mocks.replaceCurrentFile, openProjectFile: mocks.openProjectFile,
}) }));
vi.mock("./project-documents.svelte", () => ({ createProjectDocumentsStore: (options: Record<string, any>) => {
  mocks.documentOptions = options;
  return {};
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
  createDesktopProjectServices({
    client: () => null, workspace: () => workspace, operationRunning: () => false,
    sessionWorkspace: () => undefined, transcript: () => ({ items: [] }) as any,
    prepareAttachment: async () => {}, activeWorkbenchTabId: () => null,
    activeConversationWorkbenchTabId: () => null, setActiveWorkbenchTabId: vi.fn(),
    nextWorkbenchAuxOrder: () => 1, setErrorMessage: vi.fn(), clearError: vi.fn(), reportError: vi.fn(),
  });
  return {
    afterSave: mocks.documentOptions!.afterSave as (file: ProjectFilePreview, workspace: string, previewId?: number) => void,
    complete: mocks.documentOptions!.onKnowledgeJobComplete as (job: ProjectKnowledgeJob) => void,
    switchWorkspace: () => { workspace = "/other"; },
  };
}

function completedJob(): ProjectKnowledgeJob {
  return {
    id: 4, workspace: "/project", path: "wiki/checked.md", content: "Body", expectedContent: "Body",
    persistStamp: true, state: "completed", createdAt: 1, finishedAt: 2, recorded: true,
    result: { status: "clear", path: "wiki/checked.md", documentHash: "hash", modelRef: "test/model",
      checkedSources: 1, conflicts: [], notices: [], reportLanguage: "ru" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.active = undefined;
  mocks.documentOptions = undefined;
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
    expect(mocks.replaceCurrentFile).not.toHaveBeenCalled();
    afterSave(saved, "/project", 10);
    expect(mocks.replaceCurrentFile).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("notifies once with the report language and keeps the page action inside its project", async () => {
    const { complete, switchWorkspace } = fixture();
    complete(completedJob());
    expect(mocks.success).toHaveBeenCalledOnce();
    const notification = mocks.success.mock.calls[0]![0];
    expect(notification.message).toMatch(/Проверка Wiki завершена/u);
    await notification.actions[0].run();
    expect(mocks.openProjectFile).toHaveBeenCalledExactlyOnceWith("wiki/checked.md", "push", undefined, false, "document");
    switchWorkspace();
    await notification.actions[0].run();
    complete(completedJob());
    expect(mocks.openProjectFile).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it("keeps a persistence failure distinct from a successfully recorded clear check", () => {
    const { complete } = fixture();
    complete({ ...completedJob(), recorded: false, error: "File changed on disk" });
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(expect.objectContaining({ message: "Отчёт Wiki готов; отметка не сохранена" }));
  });
});
