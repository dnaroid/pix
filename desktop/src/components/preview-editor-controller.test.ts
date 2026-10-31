import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Node crypto import in Vitest runner (frontend tsconfig omits Node globals)
import { createHash } from "node:crypto";
import * as stamps from "../../../acp/src/knowledge/stamp";
import type { ProjectFilePreview, ProjectFileSaveGuard } from "../lib/project-files";
import { createPreviewEditorController } from "./preview-editor-controller.svelte";
import type { KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import type { ManualKnowledgeCheckInput, ProjectKnowledgeJob } from "../app/project-knowledge-queue.svelte";

function deferred<T = boolean>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(check?: (path: string, content: string, signal: AbortSignal) => Promise<KnowledgeCheckResult | undefined>, content = "original") {
  let id = 1;
  let workspace = "/project";
  let file: ProjectFilePreview = { path: "TODO.md", content };
  const saveFile = vi.fn(async (path: string, content: string, guard?: ProjectFileSaveGuard) => {
    if (guard && !guard.isCurrent()) return false;
    if (file.path === path) file = { ...file, content };
    return true;
  });
  const reportError = vi.fn();
  const controller = createPreviewEditorController({
    previewId: () => id,
    file: () => file,
    editable: () => true,
    workspace: () => workspace,
    onSaveProjectFile: () => saveFile,
    onCheckKnowledge: () => check,
    onKnowledgeCheckError: reportError,
    onDirtyChange: () => undefined,
  });
  return {
    controller, saveFile, reportError,
    loaded: () => file.content,
    navigate: () => { id += 1; file = { path: "plan.md", content: "next file" }; },
    replaceLoaded: (content: string) => { file = { ...file, content }; },
    openFile: (path: string, content: string) => { id += 1; file = { path, content }; },
    changeWorkspace: () => { workspace = "/another-project"; },
  };
}

function result(status: KnowledgeCheckResult["status"], path = "TODO.md", content = "submitted"): KnowledgeCheckResult {
  return {
    status, path, documentHash: createHash("sha256").update(content).digest("hex"), modelRef: "test/model", checkedSources: 1,
    conflicts: status === "conflicts" ? [{
      draft: { path, quote: "seven retries", startLine: 1, endLine: 1 },
      existing: { path: "wiki/retries.md", quote: "five retries", startLine: 3, endLine: 3 },
      explanation: "The same operation has two different retry limits.",
    }] : [],
    notices: status === "incomplete" ? ["A source could not be read."] : [],
  };
}

async function expectCheckedSave(saveFile: ReturnType<typeof fixture>["saveFile"], content: string): Promise<void> {
  const [path, saved] = saveFile.mock.calls.at(-1)!;
  expect(path).toBe("TODO.md");
  expect(stamps.stripKnowledgeCheckStamp(saved)).toBe(content);
  expect((await stamps.readKnowledgeCheckStamp(saved))?.contentHash).toBe(createHash("sha256").update(content).digest("hex"));
}
const checkedFile = (content = "original") => stamps.stampKnowledgeCheck(content, result("clear", "TODO.md", content), "2026-10-30T00:00:00.000Z");
const reportedFile = (content = "original", status: "conflicts" | "incomplete" = "conflicts") =>
  stamps.recordKnowledgeCheck(content, result(status, "TODO.md", content), "2026-10-30T01:00:00.000Z");

async function expectReportedSave(saveFile: ReturnType<typeof fixture>["saveFile"], content: string, status: "conflicts" | "incomplete"): Promise<void> {
  const [path, saved] = saveFile.mock.calls.at(-1)!;
  expect(path).toBe("TODO.md");
  expect(stamps.stripKnowledgeCheckStamp(saved)).toBe(content);
  expect(await stamps.readKnowledgeReport(saved)).toMatchObject({ current: true, result: result(status, path, content) });
  expect(await stamps.readKnowledgeCheckStamp(saved)).toBeUndefined();
}

describe("persisted Wiki reports in Preview", () => {
  it.each(["unavailable", "disabled"])("preserves the old report as stale when saving edits with checking %s", async phase => {
    const raw = await reportedFile();
    const previous = await stamps.readKnowledgeReport(raw);
    const item = fixture(phase === "unavailable" ? async () => { throw new Error("Provider disconnected"); } : undefined, raw);
    item.controller.begin();
    item.controller.updateDraft("edited after the prior report");
    await item.controller.save();
    if (phase === "unavailable") {
      expect(item.saveFile).not.toHaveBeenCalled();
      expect(item.controller.canSaveAnyway).toBe(true);
      await item.controller.saveAnyway();
    }
    const saved = item.saveFile.mock.calls.at(-1)![1];
    expect(stamps.stripKnowledgeCheckStamp(saved)).toBe("edited after the prior report");
    expect(await stamps.readKnowledgeReport(saved)).toEqual({ ...previous, current: false });
    expect(await stamps.readKnowledgeCheckStamp(saved)).toBeUndefined();
    expect(item.controller.canSaveAnyway).toBe(false);
    item.controller.dispose();
  });

  it("restores a matching report after reopening without checking or writing", async () => {
    const content = await reportedFile(), check = vi.fn();
    const item = fixture(check, content);
    await vi.waitFor(() => expect(item.controller.knowledgeResult?.status).toBe("conflicts"));
    expect(item.controller.knowledgeResult?.conflicts).toEqual(result("conflicts", "TODO.md", "original").conflicts);
    expect(item.controller.knowledgeReportStale).toBe(false);
    expect(item.controller.knowledgeReportCheckedAt).toBe("2026-10-30T01:00:00.000Z");
    expect(item.controller.state.knowledgeResult).toBeUndefined();
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
    expect(item.controller.canSaveAnyway).toBe(false);
    expect(item.controller.dirty).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(item.saveFile).not.toHaveBeenCalled();
    item.controller.dispose();
    const reopened = fixture(undefined, content);
    await vi.waitFor(() => expect(reopened.controller.knowledgeResult?.status).toBe("conflicts"));
    reopened.controller.dispose();
  });

  it("keeps a report reviewable but stale after the saved body changes", async () => {
    const original = await reportedFile();
    const changed = original.slice(0, -"original".length) + "edited after the check";
    const item = fixture(undefined, changed);
    await vi.waitFor(() => expect(item.controller.knowledgeResult?.status).toBe("conflicts"));
    expect(item.controller.knowledgeReportStale).toBe(true);
    expect(item.controller.knowledgeResult?.documentHash).toBe(result("conflicts", "TODO.md", "original").documentHash);
    expect(item.controller.canSaveAnyway).toBe(false);
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
    item.controller.begin();
    expect(item.controller.state.draft).toBe("edited after the check");
    await item.controller.saveAnyway();
    expect(item.saveFile).not.toHaveBeenCalled();
    item.controller.dispose();
  });

  it("does not reuse a report as current after its file was renamed", async () => {
    const content = await reportedFile(), item = fixture(undefined, content);
    item.openFile("renamed.md", content);
    item.controller.begin();
    await vi.waitFor(() => expect(item.controller.knowledgeResult?.status).toBe("conflicts"));
    expect(item.controller.knowledgeResult?.path).toBe("TODO.md");
    expect(item.controller.knowledgeReportStale).toBe(true);
    expect(item.controller.canSaveAnyway).toBe(false);
    item.controller.dispose();
  });

  it("marks a restored report stale while editing without granting Save anyway", async () => {
    const item = fixture(undefined, await reportedFile());
    await vi.waitFor(() => expect(item.controller.knowledgeResult).toBeDefined());
    item.controller.begin();
    expect(item.controller.state.draft).toBe("original");
    expect(item.controller.knowledgeReportStale).toBe(false);
    item.controller.updateDraft("new unsaved claim");
    expect(item.controller.knowledgeResult?.status).toBe("conflicts");
    expect(item.controller.knowledgeReportStale).toBe(true);
    expect(item.controller.canSaveAnyway).toBe(false);
    await item.controller.saveAnyway();
    expect(item.saveFile).not.toHaveBeenCalled();
    item.controller.updateDraft("original");
    expect(item.controller.knowledgeReportStale).toBe(false);
    item.controller.dispose();
  });

  it("lets a live draft check take precedence over the persisted report", async () => {
    const item = fixture(async (path, content) => result("incomplete", path, content), await reportedFile());
    await vi.waitFor(() => expect(item.controller.knowledgeResult?.status).toBe("conflicts"));
    item.controller.begin();
    item.controller.updateDraft("new claim");
    await item.controller.check();
    expect(item.controller.knowledgeResult?.status).toBe("incomplete");
    expect(item.controller.knowledgeResult?.documentHash).toBe(result("incomplete", "TODO.md", "new claim").documentHash);
    expect(item.controller.knowledgeReportStale).toBe(false);
    expect(item.controller.knowledgeReportCheckedAt).toBeUndefined();
    expect(item.saveFile).not.toHaveBeenCalled();
    item.controller.dispose();
  });

  it("lets an active or newly completed manual check take precedence", async () => {
    const item = queuedFixture(await reportedFile());
    await vi.waitFor(() => expect(item.controller.knowledgeResult?.status).toBe("conflicts"));
    await item.controller.check();
    expect(item.controller.checking).toBe(true);
    item.finish(1, "incomplete", "Report recording failed", Date.parse("2026-10-30T02:00:00.000Z"));
    expect(item.controller.knowledgeResult?.status).toBe("incomplete");
    expect(item.controller.knowledgeReportStale).toBe(false);
    expect(item.controller.knowledgeReportCheckedAt).toBeUndefined();
    expect(item.controller.knowledgeRecordingError).toBe("Report recording failed");
    item.controller.dispose();
  });

  it("does not revive an older terminal job over a newer persisted report", async () => {
    const item = queuedFixture();
    await item.controller.check();
    item.finish(1, "incomplete", undefined, Date.parse("2026-10-30T00:00:00.000Z"));
    item.controller.dispose();
    item.navigate("TODO.md", await reportedFile());
    const reopened = item.create();
    await vi.waitFor(() => expect(reopened.state.savedKnowledgeReport).toBeDefined());
    expect(reopened.knowledgeResult?.status).toBe("conflicts");
    expect(reopened.knowledgeReportCheckedAt).toBe("2026-10-30T01:00:00.000Z");
    reopened.dispose();
  });

  it("dismisses only the visible restored report without modifying its saved block", async () => {
    const content = await reportedFile(), item = fixture(undefined, content);
    await vi.waitFor(() => expect(item.controller.knowledgeResult).toBeDefined());
    item.controller.cancelCheck();
    expect(item.controller.knowledgeResult).toBeUndefined();
    item.controller.begin();
    expect(item.controller.knowledgeResult).toBeUndefined();
    expect(item.loaded()).toBe(content);
    expect(item.saveFile).not.toHaveBeenCalled();
    item.controller.dispose();
    const reopened = fixture(undefined, content);
    await vi.waitFor(() => expect(reopened.controller.knowledgeResult).toBeDefined());
    reopened.controller.dispose();
  });

  it("removes the stored report after a new clear result", async () => {
    const item = fixture(async (path, content) => result("clear", path, content), await reportedFile());
    await vi.waitFor(() => expect(item.controller.knowledgeResult?.status).toBe("conflicts"));
    await item.controller.check();
    expect(item.controller.knowledgeResult?.status).toBe("clear");
    await expectCheckedSave(item.saveFile, "original");
    expect(await stamps.readKnowledgeReport(item.loaded())).toBeUndefined();
    expect(item.controller.knowledgeReportStale).toBe(false);
    item.controller.dispose();
    const reopened = fixture(undefined, item.loaded());
    await vi.waitFor(() => expect(reopened.controller.savedKnowledgeStamp).toBeDefined());
    expect(reopened.controller.knowledgeResult).toBeUndefined();
    reopened.controller.dispose();
  });

  for (const invalidate of ["navigate", "workspace", "source", "dispose"] as const) {
    it(`ignores an obsolete report validation after ${invalidate}`, async () => {
      const content = await reportedFile(), saved = await stamps.readKnowledgeReport(content);
      const pending = deferred<typeof saved>();
      const spy = vi.spyOn(stamps, "readKnowledgeReport").mockReturnValueOnce(pending.promise);
      try {
        const item = fixture(undefined, content);
        if (invalidate === "navigate") { item.navigate(); item.controller.begin(); }
        else if (invalidate === "workspace") item.changeWorkspace();
        else if (invalidate === "source") item.replaceLoaded("external change");
        else item.controller.dispose();
        pending.resolve(saved);
        await pending.promise;
        await Promise.resolve();
        expect(item.controller.knowledgeResult).toBeUndefined();
        expect(item.controller.state.savedKnowledgeReport).toBeUndefined();
        item.controller.dispose();
      } finally { spy.mockRestore(); }
    });
  }

  it("keeps runtime failures bare when Save anyway has no completed report", async () => {
    const item = fixture(async () => { throw new Error("offline"); });
    item.controller.begin();
    item.controller.updateDraft("explicitly saved without a check");
    await item.controller.save();
    expect(item.controller.canSaveAnyway).toBe(true);
    await item.controller.saveAnyway();
    expect(item.loaded()).toBe("explicitly saved without a check");
    expect(await stamps.readKnowledgeReport(item.loaded())).toBeUndefined();
    item.controller.dispose();
  });
});

function queuedFixture(content = "original") {
  let file: ProjectFilePreview = { path: "TODO.md", content };
  let previewId = 1;
  let workspace = "/project";
  let jobs: ProjectKnowledgeJob[] = [];
  const saveFile = vi.fn(async (_path: string, _content: string, _guard?: ProjectFileSaveGuard) => true);
  const foregroundCheck = vi.fn(async (path: string, body: string) => result("clear", path, body));
  const enqueue = vi.fn((input: ManualKnowledgeCheckInput) => {
    const id = jobs.length + 1;
    jobs = [...jobs, { ...input, id, workspace, state: "queued", createdAt: 0 }];
    return id;
  });
  const cancel = vi.fn((id: number) => { jobs = jobs.map((job) => job.id === id ? { ...job, state: "cancelled" } : job); });
  const create = () => createPreviewEditorController({
    previewId: () => previewId, file: () => file, workspace: () => workspace,
    editable: () => true, onSaveProjectFile: () => saveFile, onCheckKnowledge: () => foregroundCheck,
    knowledgeJobs: () => jobs, onEnqueueKnowledgeCheck: () => enqueue, onCancelKnowledgeCheck: () => cancel,
    onDirtyChange: () => undefined,
  });
  return {
    controller: create(), create, saveFile, foregroundCheck, enqueue, cancel,
    jobs: () => jobs,
    navigate: (path: string, content: string) => { previewId += 1; file = { path, content }; },
    replaceLoaded: (content: string) => { file = { ...file, content }; },
    workspace: (path: string) => { workspace = path; },
    finish: (id: number, status: KnowledgeCheckResult["status"], error?: string, finishedAt = Date.now()) => {
      jobs = jobs.map((job) => job.id === id ? { ...job, state: "completed", finishedAt, result: result(status, job.path, job.content), ...(error ? { error, recorded: false } : {}) } : job);
    },
  };
}

describe("project-owned manual Wiki checks", () => {
  it("queues the exact saved snapshot without starting a preview-owned request or save", async () => {
    const item = queuedFixture();
    await item.controller.check();

    expect(item.enqueue).toHaveBeenCalledExactlyOnceWith({ path: "TODO.md", content: "original", expectedContent: "original", persistStamp: true });
    expect(item.controller.checking).toBe(true);
    expect(item.controller.queued).toBe(true);
    expect(item.foregroundCheck).not.toHaveBeenCalled();
    expect(item.saveFile).not.toHaveBeenCalled();
    await item.controller.check();
    expect(item.enqueue).toHaveBeenCalledTimes(1);
  });

  it("retains the pending job through page navigation and controller disposal, then restores its report", async () => {
    const item = queuedFixture();
    await item.controller.check();
    item.navigate("wiki/other.md", "other");
    expect(item.controller.checking).toBe(false);
    expect(item.controller.knowledgeResult).toBeUndefined();
    item.controller.dispose();
    expect(item.cancel).not.toHaveBeenCalled();

    item.finish(1, "conflicts");
    item.navigate("TODO.md", "original");
    const reopened = item.create();
    expect(reopened.checking).toBe(false);
    expect(reopened.knowledgeResult?.status).toBe("conflicts");
    expect(item.saveFile).not.toHaveBeenCalled();
    reopened.dispose();
  });

  it("keeps an edited draft's check as a background snapshot without saving it", async () => {
    const item = queuedFixture();
    item.controller.begin();
    item.controller.updateDraft("unsaved draft");
    await item.controller.check();
    expect(item.enqueue).toHaveBeenCalledExactlyOnceWith({ path: "TODO.md", content: "unsaved draft", expectedContent: "original", persistStamp: false });

    item.controller.updateDraft("newer draft");
    expect(item.controller.checking).toBe(false);
    item.finish(1, "conflicts");
    expect(item.controller.knowledgeResult).toBeUndefined();
    item.controller.cancel();
    item.controller.dispose();
    expect(item.cancel).not.toHaveBeenCalled();
    expect(item.jobs()[0]?.result?.status).toBe("conflicts");
    expect(item.saveFile).not.toHaveBeenCalled();
  });

  it("cancels a project job only through the explicit Cancel check action", async () => {
    const item = queuedFixture();
    await item.controller.check();
    item.controller.cancelCheck();
    expect(item.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(item.controller.checking).toBe(false);
    expect(item.controller.knowledgeResult).toBeUndefined();
  });

  it("does not apply another workspace, page or changed version's retained result", async () => {
    const item = queuedFixture();
    await item.controller.check();
    item.finish(1, "clear");
    item.navigate("TODO.md", "changed");
    expect(item.controller.knowledgeResult).toBeUndefined();
    item.navigate("wiki/other.md", "original");
    expect(item.controller.knowledgeResult).toBeUndefined();
    item.navigate("TODO.md", "original");
    item.workspace("/another-project");
    expect(item.controller.knowledgeResult).toBeUndefined();
    expect(item.jobs()[0]?.result?.status).toBe("clear");
  });

  it("uses the ordinary guarded foreground check for Save and never queues an automatic save", async () => {
    const item = queuedFixture();
    item.controller.begin();
    item.controller.updateDraft("submitted");
    await item.controller.save();
    expect(item.enqueue).not.toHaveBeenCalled();
    expect(item.foregroundCheck).toHaveBeenCalledExactlyOnceWith("TODO.md", "submitted", expect.any(AbortSignal));
    expect(item.saveFile).toHaveBeenCalledTimes(1);
    expect(stamps.stripKnowledgeCheckStamp(item.saveFile.mock.calls[0]![1] as string)).toBe("submitted");
  });

  it("keeps a nonclear saved-page result visible and its old badge suppressed after recording failed", async () => {
    const saved = await checkedFile();
    const item = queuedFixture(saved);
    await vi.waitFor(() => expect(item.controller.savedKnowledgeStamp).toBeDefined());
    await item.controller.check();
    expect(item.enqueue).toHaveBeenCalledWith({ path: "TODO.md", content: "original", expectedContent: saved, persistStamp: true });
    item.finish(1, "conflicts", "File changed before the check mark could be removed.");
    expect(item.controller.knowledgeResult?.status).toBe("conflicts");
    expect(item.controller.knowledgeRecordingError).toMatch(/File changed/);
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
    item.controller.cancelCheck();
    expect(item.controller.knowledgeResult).toBeUndefined();
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
    expect(item.cancel).not.toHaveBeenCalled();
    item.controller.dispose();
    const reopened = item.create();
    await vi.waitFor(() => expect(reopened.state.savedKnowledgeStamp).toBeDefined());
    expect(reopened.savedKnowledgeStamp).toBeUndefined();
    expect(reopened.knowledgeResult?.status).toBe("conflicts");
    reopened.dispose();
  });

  it("lets a newer successful foreground save supersede an older manual failure for the same text", async () => {
    const item = queuedFixture();
    item.saveFile.mockImplementation(async (_path, content) => { item.replaceLoaded(content); return true; });
    item.controller.begin();
    item.controller.updateDraft("new body");
    await item.controller.check();
    item.finish(1, "incomplete", undefined, 0);
    expect(item.controller.knowledgeResult?.status).toBe("incomplete");

    await item.controller.save();
    expect(item.foregroundCheck).toHaveBeenCalledExactlyOnceWith("TODO.md", "new body", expect.any(AbortSignal));
    const saved = item.saveFile.mock.calls.at(-1)![1];
    expect((await stamps.readKnowledgeCheckStamp(saved))?.contentHash).toBe(result("clear", "TODO.md", "new body").documentHash);
    await vi.waitFor(() => expect(item.controller.savedKnowledgeStamp).toBeDefined());
    item.controller.dispose();
    item.navigate("TODO.md", saved);
    const reopened = item.create();
    await vi.waitFor(() => expect(reopened.savedKnowledgeStamp).toBeDefined());
    expect(reopened.knowledgeResult).toBeUndefined();
    expect(item.jobs()[0]?.result?.status).toBe("incomplete");
    reopened.dispose();
  });
});

describe("Preview save ownership", () => {
  it("allows editing non-Markdown text files when Preview marks them editable", () => {
    const { controller } = fixture();
    controller.begin();
    expect(controller.state.editing).toBe(true);
  });

  it("retains changes typed while an earlier draft is being saved", async () => {
    const { controller, saveFile } = fixture();
    const pending = deferred();
    saveFile.mockReturnValue(pending.promise);
    controller.begin();
    controller.state.draft = "submitted";
    const saving = controller.save();
    controller.state.draft = "typed during save";
    pending.resolve(true);
    await saving;
    expect(saveFile).toHaveBeenCalledWith("TODO.md", "submitted");
    expect(controller.state).toMatchObject({ editing: true, saving: false, draft: "typed during save" });
    expect(controller.dirty).toBe(true);
  });

  it("does not let the previous file's save unlock or close a new edit", async () => {
    const { controller, saveFile, navigate } = fixture();
    const first = deferred();
    const second = deferred();
    saveFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    controller.begin();
    controller.state.draft = "old file draft";
    const oldSave = controller.save();
    navigate();
    controller.begin();
    controller.state.draft = "new file draft";
    const newSave = controller.save();
    first.resolve(true);
    await oldSave;
    expect(controller.state).toMatchObject({ editing: true, saving: true, draft: "new file draft" });
    second.resolve(true);
    await newSave;
    expect(controller.state).toMatchObject({ editing: false, saving: false });
  });

  it("ignores a late save after cancelling and beginning a new edit", async () => {
    const { controller, saveFile } = fixture();
    const pending = deferred();
    saveFile.mockReturnValue(pending.promise);
    controller.begin();
    controller.state.draft = "submitted";
    const saving = controller.save();
    controller.cancel();
    controller.begin();
    controller.state.draft = "replacement draft";
    pending.resolve(true);
    await saving;
    expect(controller.state).toMatchObject({ editing: true, saving: false, draft: "replacement draft" });
  });
});

describe("Wiki check before Preview save", () => {
  it("waits for a clear check before atomically writing its body and stamp", async () => {
    const pending = deferred<KnowledgeCheckResult>();
    const check = vi.fn(() => pending.promise);
    const { controller, saveFile } = fixture(check);
    controller.begin();
    controller.updateDraft("submitted");
    const saving = controller.save();
    expect(controller.state.checking).toBe(true);
    expect(saveFile).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith("TODO.md", "submitted", expect.any(AbortSignal));
    pending.resolve(result("clear"));
    await saving;
    await expectCheckedSave(saveFile, "submitted");
    expect(controller.state).toMatchObject({ checking: false, saving: false, editing: false });
  });

  for (const editedDuringCheck of [false, true]) {
    it(editedDuringCheck ? "ignores clear bounded coverage after the draft changes" : "saves a clear review with ordinary coverage limits", async () => {
      const pending = deferred<KnowledgeCheckResult>();
      const { controller, saveFile } = fixture(() => pending.promise);
      const boundedResult: KnowledgeCheckResult = {
        ...result("clear", "TODO.md", "checked draft"),
        coverage: {
          scope: "retrieved-passages", checkedPassages: 1, candidateSources: 20, excerptedSources: 1,
          limits: ["query-sampling", "candidate-limit", "source-limit", "passage-limit", "context-limit"],
        },
      };
      controller.begin();
      controller.updateDraft("checked draft");
      const saving = controller.save();
      expect(saveFile).not.toHaveBeenCalled();
      if (editedDuringCheck) controller.updateDraft("newer draft");
      pending.resolve(boundedResult);
      await saving;

      if (editedDuringCheck) {
        expect(saveFile).not.toHaveBeenCalled();
        expect(controller.state).toMatchObject({ draft: "newer draft", editing: true, checking: false });
        expect(controller.state.knowledgeResult).toBeUndefined();
      } else {
        expect(saveFile).toHaveBeenCalledTimes(1);
        await expectCheckedSave(saveFile, "checked draft");
        expect(controller.state).toMatchObject({ editing: false, checking: false });
      }
      expect(controller.canSaveAnyway).toBe(false);
    });
  }

  for (const status of ["conflicts", "incomplete"] as const) {
    it(`preserves a ${status} draft until explicit Save anyway`, async () => {
      const check = vi.fn(async (path: string, content: string) => result(status, path, content));
      const { controller, saveFile } = fixture(check);
      controller.begin();
      controller.updateDraft("seven retries");
      await controller.save();
      expect(saveFile).not.toHaveBeenCalled();
      expect(controller.state).toMatchObject({ editing: true, checking: false, saving: false, draft: "seven retries" });
      expect(controller.state.knowledgeResult?.status).toBe(status);
      expect(controller.canSaveAnyway).toBe(true);
      await controller.saveAnyway();
      expect(saveFile).toHaveBeenCalledWith("TODO.md", expect.any(String), expect.objectContaining({ expectedContent: "original", isCurrent: expect.any(Function) }));
      await expectReportedSave(saveFile, "seven retries", status);
      expect(check).toHaveBeenCalledTimes(1);
    });
  }

  it("invalidates approval when the checked text changes", async () => {
    const { controller, saveFile } = fixture(async () => result("conflicts"));
    controller.begin();
    controller.updateDraft("seven retries");
    await controller.save();
    controller.updateDraft("a different claim");
    expect(controller.state.knowledgeResult).toBeUndefined();
    expect(controller.canSaveAnyway).toBe(false);
    await controller.saveAnyway();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("does not reuse an earlier result on a normal Save", async () => {
    const check = vi.fn(async () => result("conflicts"));
    const { controller, saveFile } = fixture(check);
    controller.begin();
    controller.updateDraft("seven retries");
    await controller.save();
    await controller.save();
    expect(check).toHaveBeenCalledTimes(2);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("supports a manual check without saving even when the result is clear", async () => {
    const { controller, saveFile } = fixture(async (path, content) => result("clear", path, content));
    controller.begin();
    await controller.check();
    expect(controller.state.knowledgeResult?.status).toBe("clear");
    expect(saveFile).not.toHaveBeenCalled();
    expect(controller.canSaveAnyway).toBe(false);
  });

  it("lets non-Wiki files save when the checker returns undefined", async () => {
    const { controller, saveFile } = fixture(async () => undefined);
    controller.begin();
    controller.updateDraft("ordinary file");
    await controller.save();
    expect(saveFile).toHaveBeenCalledWith("TODO.md", "ordinary file");
    expect(controller.state.knowledgeResult).toBeUndefined();
  });

  it("reports check failures and keeps the draft instead of silently writing", async () => {
    const failure = new Error("model unavailable");
    const { controller, saveFile, reportError } = fixture(async () => { throw failure; });
    controller.begin();
    controller.updateDraft("submitted");
    await controller.save();
    expect(saveFile).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(controller.state.knowledgeResult?.status).toBe("incomplete");
    expect(controller.canSaveAnyway).toBe(true);
  });

  it("rejects a result for a different document", async () => {
    const { controller, saveFile, reportError } = fixture(async () => result("clear", "another.md"));
    controller.begin();
    controller.updateDraft("submitted");
    await controller.save();
    expect(saveFile).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(controller.state.knowledgeResult?.status).toBe("incomplete");
  });

  it("aborts and ignores a late clear result after typing during the check", async () => {
    const pending = deferred<KnowledgeCheckResult>();
    const check = vi.fn((_path: string, _content: string, _signal: AbortSignal) => pending.promise);
    const { controller, saveFile } = fixture(check);
    controller.begin();
    controller.updateDraft("submitted");
    const saving = controller.save();
    controller.updateDraft("typed during check");
    expect(check.mock.calls[0]![2].aborted).toBe(true);
    pending.resolve(result("clear"));
    await saving;
    expect(saveFile).not.toHaveBeenCalled();
    expect(controller.state).toMatchObject({ draft: "typed during check", checking: false, editing: true });
  });

  it("fences direct draft changes even before the reactive invalidation effect", async () => {
    const pending = deferred<KnowledgeCheckResult>();
    const { controller, saveFile } = fixture(() => pending.promise);
    controller.begin();
    controller.state.draft = "submitted";
    const saving = controller.save();
    controller.state.draft = "changed directly";
    pending.resolve(result("clear"));
    await saving;
    expect(saveFile).not.toHaveBeenCalled();
    expect(controller.state.knowledgeResult).toBeUndefined();
  });

  for (const invalidate of ["cancel", "navigate", "workspace", "source", "dispose"] as const) {
    it(`ignores a late result after ${invalidate}`, async () => {
      const pending = deferred<KnowledgeCheckResult>();
      const item = fixture(() => pending.promise);
      item.controller.begin();
      item.controller.updateDraft("submitted");
      const saving = item.controller.save();
      if (invalidate === "cancel") item.controller.cancelCheck();
      else if (invalidate === "navigate") item.navigate();
      else if (invalidate === "workspace") item.changeWorkspace();
      else if (invalidate === "source") item.replaceLoaded("changed on disk");
      else item.controller.dispose();
      pending.resolve(result("clear"));
      await saving;
      expect(item.saveFile).not.toHaveBeenCalled();
      expect(item.controller.state.knowledgeResult).toBeUndefined();
    });
  }

  it("does not let a cancelled old check unlock a newer check", async () => {
    const first = deferred<KnowledgeCheckResult>(), second = deferred<KnowledgeCheckResult>();
    const check = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { controller, saveFile } = fixture(check);
    controller.begin();
    controller.updateDraft("first");
    const oldSave = controller.save();
    controller.updateDraft("second");
    const newSave = controller.save();
    first.resolve(result("clear"));
    await oldSave;
    expect(controller.state.checking).toBe(true);
    expect(saveFile).not.toHaveBeenCalled();
    second.resolve(result("clear", "TODO.md", "second"));
    await newSave;
    expect(saveFile).toHaveBeenCalledTimes(1);
    await expectCheckedSave(saveFile, "second");
  });

  it("releases a cancelled check without waiting for an uncooperative provider", async () => {
    const pending = deferred<KnowledgeCheckResult>();
    const { controller, saveFile } = fixture(() => pending.promise);
    controller.begin();
    controller.updateDraft("submitted");
    const saving = controller.save();
    controller.cancelCheck();
    await saving;
    expect(controller.state.checking).toBe(false);
    expect(saveFile).not.toHaveBeenCalled();
    pending.resolve(result("clear"));
    await Promise.resolve();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("preserves text typed during the disk write after a completed check", async () => {
    const pending = deferred();
    const { controller, saveFile } = fixture(async (path, content) => result("clear", path, content));
    saveFile.mockReturnValue(pending.promise);
    controller.begin();
    controller.updateDraft("submitted");
    const saving = controller.save();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());
    controller.updateDraft("typed during write");
    pending.resolve(true);
    await saving;
    expect(controller.state).toMatchObject({ editing: true, saving: false, draft: "typed during write" });
  });
});


describe("saved Wiki check stamps in Preview", () => {
  it("checks the saved body without entering Edit and persists only its metadata", async () => {
    const previous = await checkedFile(), pending = deferred<KnowledgeCheckResult>();
    const check = vi.fn(() => pending.promise), item = fixture(check, previous);
    const checking = item.controller.check();
    expect(item.controller.state.editing).toBe(false);
    expect(item.controller.dirty).toBe(false);
    expect(check).toHaveBeenCalledWith("TODO.md", "original", expect.any(AbortSignal));
    expect(item.loaded()).toBe(previous);
    expect(item.saveFile).not.toHaveBeenCalled();
    pending.resolve(result("clear", "TODO.md", "original"));
    await checking;
    await expectCheckedSave(item.saveFile, "original");
    expect(item.controller.state.knowledgeResult?.status).toBe("clear");
    expect(item.controller.state.editing).toBe(false);
    expect(item.controller.dirty).toBe(false);
    await vi.waitFor(() => expect(item.controller.savedKnowledgeStamp?.contentHash).toBe(result("clear", "TODO.md", "original").documentHash));
  });

  it("hides the footer in Edit and marks only the unchanged saved body green", async () => {
    const previous = await checkedFile(), item = fixture(async (path, content) => result("clear", path, content), previous);
    item.controller.begin();
    expect(item.controller.state.draft).toBe("original");
    expect(item.controller.dirty).toBe(false);
    await vi.waitFor(() => expect(item.controller.savedKnowledgeStamp).toBeDefined());
    item.controller.updateDraft("edited body");
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
    await item.controller.check();
    expect(item.controller.state.knowledgeResult?.status).toBe("clear");
    expect(item.saveFile).not.toHaveBeenCalled();
    expect(item.loaded()).toBe(previous);
    item.controller.cancel();
    expect(item.controller.savedKnowledgeStamp).toBeDefined();
  });

  it("rejects a clear result whose hash belongs to different content", async () => {
    const item = fixture(async () => result("clear", "TODO.md", "different body"));
    await item.controller.check();
    expect(item.saveFile).not.toHaveBeenCalled();
    expect(item.controller.state.knowledgeResult?.status).toBe("incomplete");
    expect(item.reportError).toHaveBeenCalledTimes(1);
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
  });

  for (const status of ["conflicts", "incomplete"] as const) {
    it(`replaces an earlier green stamp with the completed ${status} Preview report`, async () => {
      const item = fixture(async () => result(status, "TODO.md", "original"), await checkedFile());
      await item.controller.check();
      expect(item.saveFile).toHaveBeenCalledTimes(1);
      expect(item.saveFile).toHaveBeenCalledWith("TODO.md", expect.any(String), expect.objectContaining({ isCurrent: expect.any(Function) }));
      await expectReportedSave(item.saveFile, "original", status);
      expect(item.controller.state.knowledgeResult?.status).toBe(status);
      expect(item.controller.savedKnowledgeStamp).toBeUndefined();
      expect(item.controller.canSaveAnyway).toBe(false);
      expect(item.controller.dirty).toBe(false);
    });
  }

  it("persists a non-clear Preview report without changing the saved body", async () => {
    const item = fixture(async () => result("incomplete", "TODO.md", "original"));
    await item.controller.check();
    expect(item.saveFile).toHaveBeenCalledTimes(1);
    await expectReportedSave(item.saveFile, "original", "incomplete");
    expect(item.controller.state.knowledgeResult?.status).toBe("incomplete");
  });

  it("keeps a previous stamp untouched when the check fails at runtime", async () => {
    const previous = await checkedFile(), failure = new Error("unavailable");
    const item = fixture(async () => { throw failure; }, previous);
    await item.controller.check();
    expect(item.saveFile).not.toHaveBeenCalled();
    expect(item.loaded()).toBe(previous);
    expect(item.controller.state.knowledgeResult?.status).toBe("incomplete");
    expect(item.reportError).toHaveBeenCalledWith(failure);
    expect(item.controller.canSaveAnyway).toBe(false);
  });

  it("Save anyway records the exact checked draft and replaces the old success stamp", async () => {
    const previous = await checkedFile();
    const item = fixture(async (path, content) => result("conflicts", path, content), previous);
    item.controller.begin();
    item.controller.updateDraft("unreviewed changes");
    await item.controller.save();
    await item.controller.saveAnyway();
    expect(item.saveFile).toHaveBeenCalledTimes(1);
    expect(item.saveFile).toHaveBeenCalledWith("TODO.md", expect.any(String), expect.objectContaining({ expectedContent: previous, isCurrent: expect.any(Function) }));
    await expectReportedSave(item.saveFile, "unreviewed changes", "conflicts");
    expect(await stamps.readKnowledgeCheckStamp(item.loaded())).toBeUndefined();
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
  });

  for (const invalidate of ["cancel", "navigate", "workspace", "source", "edit", "dispose"] as const) {
    it(`does not start a metadata save after ${invalidate} while checking Preview`, async () => {
      const pending = deferred<KnowledgeCheckResult>(), item = fixture(() => pending.promise);
      const checking = item.controller.check();
      if (invalidate === "cancel") item.controller.cancelCheck();
      else if (invalidate === "navigate") item.navigate();
      else if (invalidate === "workspace") item.changeWorkspace();
      else if (invalidate === "source") item.replaceLoaded("external change");
      else if (invalidate === "edit") { item.controller.begin(); item.controller.updateDraft("unsaved draft"); }
      else item.controller.dispose();
      pending.resolve(result("clear", "TODO.md", "original"));
      await checking;
      expect(item.saveFile).not.toHaveBeenCalled();
      expect(item.controller.state.knowledgeResult).toBeUndefined();
      if (invalidate === "edit") expect(item.controller.state.draft).toBe("unsaved draft");
    });
  }

  it("a cancelled digest cannot start a save or unlock a newer Preview check", async () => {
    const prepared = deferred<string>(), later = deferred<KnowledgeCheckResult>();
    const spy = vi.spyOn(stamps, "recordKnowledgeCheck").mockReturnValueOnce(prepared.promise);
    try {
      const check = vi.fn().mockResolvedValueOnce(result("clear", "TODO.md", "original")).mockReturnValueOnce(later.promise);
      const item = fixture(check);
      const first = item.controller.check();
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      item.controller.cancelCheck();
      const second = item.controller.check();
      prepared.resolve("obsolete prepared stamp");
      await first;
      expect(item.saveFile).not.toHaveBeenCalled();
      expect(item.controller.state.checking).toBe(true);
      later.resolve(result("clear", "TODO.md", "original"));
      await second;
      expect(item.saveFile).toHaveBeenCalledTimes(1);
      await expectCheckedSave(item.saveFile, "original");
    } finally { spy.mockRestore(); }
  });

  it("retains the report through its own metadata update before save resolves", async () => {
    const item = fixture(async (path, content) => result("clear", path, content)), pending = deferred();
    item.saveFile.mockImplementation(async (_path, content) => {
      item.replaceLoaded(content);
      await pending.promise;
      return true;
    });
    const checking = item.controller.check();
    await vi.waitFor(() => expect(item.saveFile).toHaveBeenCalledTimes(1));
    await item.controller.check(); // Synchronize the own write while it is still pending.
    expect(item.controller.state.knowledgeResult?.status).toBe("clear");
    pending.resolve(true);
    await checking;
    expect(item.controller.state.knowledgeResult?.status).toBe("clear");
  });

  it("does not let an obsolete stamp digest mark a replacement file green", async () => {
    const previous = await checkedFile(), stamp = await stamps.readKnowledgeCheckStamp(previous), pending = deferred<typeof stamp>();
    const spy = vi.spyOn(stamps, "readKnowledgeCheckStamp").mockReturnValueOnce(pending.promise);
    try {
      const item = fixture(undefined, previous);
      item.navigate();
      item.controller.begin();
      pending.resolve(stamp);
      await Promise.resolve();
      expect(item.controller.savedKnowledgeStamp).toBeUndefined();
      expect(item.controller.state.savedKnowledgeStamp).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it("retains a completed non-clear verdict when removing an old stamp fails", async () => {
    const previous = await checkedFile(), item = fixture(async () => result("conflicts", "TODO.md", "original"), previous);
    await vi.waitFor(() => expect(item.controller.savedKnowledgeStamp).toBeDefined());
    item.saveFile.mockResolvedValue(false);
    await item.controller.check();
    expect(item.loaded()).toBe(previous);
    expect(item.controller.state.knowledgeResult?.status).toBe("conflicts");
    expect(item.controller.state.knowledgeResult?.conflicts).toHaveLength(1);
    expect(item.controller.state.knowledgeResult?.notices.join(" ")).toContain("could not be recorded");
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
    item.controller.cancelCheck();
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
  });

  it("binds checked saves to the exact raw source including an existing footer", async () => {
    const previous = await checkedFile(), item = fixture(async (path, content) => result("clear", path, content), previous);
    item.saveFile.mockImplementation(async (_path, content, guard) => {
      expect(guard?.expectedContent).toBe(previous);
      expect(guard?.isCurrent()).toBe(true);
      item.replaceLoaded(content);
      return true;
    });
    await item.controller.check();
    await expectCheckedSave(item.saveFile, "original");
  });

  for (const invalidate of ["cancel", "source", "workspace", "edit"] as const) {
    it(`revokes a queued metadata save after ${invalidate} before its actual write`, async () => {
      const release = deferred(), writes: string[] = [];
      const item = fixture(async (path, content) => result("clear", path, content));
      item.saveFile.mockImplementation(async (_path, content, guard) => {
        await release.promise;
        if (!guard?.isCurrent()) return false;
        writes.push(content);
        item.replaceLoaded(content);
        return true;
      });
      const checking = item.controller.check();
      await vi.waitFor(() => expect(item.saveFile).toHaveBeenCalledTimes(1));
      if (invalidate === "cancel") item.controller.cancelCheck();
      else if (invalidate === "source") item.replaceLoaded("external change");
      else if (invalidate === "workspace") item.changeWorkspace();
      else { item.controller.begin(); item.controller.updateDraft("unsaved draft"); }
      release.resolve(true);
      await checking;
      expect(writes).toEqual([]);
      expect(item.controller.state.knowledgeResult).toBeUndefined();
    });
  }

  it("cancels a newer stamp digest while an older native write is still pending", async () => {
    const firstDisk = deferred(), prepared = deferred<string>();
    const item = fixture(async (path, content) => result("clear", path, content));
    item.saveFile.mockReturnValueOnce(firstDisk.promise);
    item.controller.begin();
    item.controller.updateDraft("first draft");
    const first = item.controller.save();
    await vi.waitFor(() => expect(item.saveFile).toHaveBeenCalledTimes(1));
    item.controller.begin();
    item.controller.updateDraft("second draft");
    const spy = vi.spyOn(stamps, "recordKnowledgeCheck").mockReturnValueOnce(prepared.promise);
    try {
      const second = item.controller.save();
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      item.controller.cancelCheck();
      expect(item.controller.state.saving).toBe(false);
      prepared.resolve("obsolete prepared stamp");
      await second;
      expect(item.saveFile).toHaveBeenCalledTimes(1);
      firstDisk.resolve(true);
      await first;
      expect(item.controller.state).toMatchObject({ editing: true, saving: false, draft: "second draft" });
    } finally { spy.mockRestore(); }
  });

  it("does not keep a clear result when its metadata save fails", async () => {
    const item = fixture(async (path, content) => result("clear", path, content));
    item.saveFile.mockResolvedValue(false);
    await item.controller.check();
    expect(item.controller.state.knowledgeResult?.status).toBe("incomplete");
    expect(item.controller.savedKnowledgeStamp).toBeUndefined();
    expect(item.reportError).toHaveBeenCalledTimes(1);
  });
});
