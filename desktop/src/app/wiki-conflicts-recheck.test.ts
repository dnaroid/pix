import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import type { ProjectFilePreview } from "../lib/project-files";
import type { WikiFinding } from "../lib/wiki-conflicts-index";
import type { ManualKnowledgeCheckInput, ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";
import { createWikiConflictsRecheck } from "./wiki-conflicts-recheck.svelte";

const citation = (path: string, quote: string, startLine = 1, endLine = startLine): KnowledgeCitation => ({ path, quote, startLine, endLine });
const finding = (id: string, extra: Partial<WikiFinding> = {}): WikiFinding => ({
  id, kind: "conflict", internal: false,
  draft: citation("wiki/a.md", "Claim A."), existing: citation("wiki/b.md", "Claim B.", 3),
  explanation: "Rules differ.", reportPath: "wiki/a.md", checkedAt: "2026-10-30T00:00:00.000Z",
  current: true, modelRef: "test/judge", reportPaths: ["wiki/a.md"], stale: false, decisionPartial: false, ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup() {
  let workspace = "/project";
  let jobs: ProjectKnowledgeJob[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<ProjectFilePreview>>>();
  const read = vi.fn((_workspace: string, _wiki: string, path: string) => {
    const next = deferred<ProjectFilePreview>();
    pending.set(path, next);
    return next.promise;
  });
  const enqueue = vi.fn((input: ManualKnowledgeCheckInput) => {
    const id = jobs.length + 1;
    jobs = [...jobs, { ...input, id, workspace, origin: "manual", state: "queued", createdAt: id } as ProjectKnowledgeJob];
    return id;
  });
  const reportError = vi.fn();
  const recheck = createWikiConflictsRecheck({
    workspace: () => workspace, wikiPath: () => "wiki", jobs: () => jobs, read, enqueue, reportError,
  });
  return {
    recheck, read, enqueue, reportError,
    complete() { jobs = jobs.map(job => ({ ...job, state: "completed" })); },
    select(value: string) { workspace = value; },
    resolve(path: string, content = `${path} body`) {
      pending.get(path)!.resolve({ path, content } as ProjectFilePreview);
    },
  };
}

describe("Wiki finding recheck", () => {
  it("queues each reporting page once as an ordinary saved-page check", async () => {
    const item = setup();
    const target = finding("f", { reportPaths: ["wiki/a.md", "wiki/b.md"] });
    const first = item.recheck.recheck(target);
    const repeated = item.recheck.recheck(target);
    expect(item.recheck.rechecking(target)).toBe(true);
    item.resolve("wiki/a.md");
    item.resolve("wiki/b.md");
    expect(await first).toBe(2);
    expect(await repeated).toBe(0);
    expect(item.read).toHaveBeenCalledTimes(2);
    expect(item.enqueue).toHaveBeenCalledWith({
      path: "wiki/a.md", content: "wiki/a.md body", expectedContent: "wiki/a.md body", persistStamp: true,
    });
    expect(item.recheck.rechecking(target)).toBe(true);
    expect(await item.recheck.recheck(target)).toBe(0);
    item.complete();
    expect(item.recheck.rechecking(target)).toBe(false);
  });

  it("skips a page that another entry point queued while the file was being read", async () => {
    const item = setup();
    const pendingRecheck = item.recheck.recheck(finding("f"));
    item.enqueue({ path: "wiki/a.md", content: "x", expectedContent: "x", persistStamp: true });
    item.resolve("wiki/a.md");
    expect(await pendingRecheck).toBe(0);
    expect(item.enqueue).toHaveBeenCalledOnce();
  });

  it("does not queue or report after a project switch or dispose", async () => {
    const switched = setup();
    const afterSwitch = switched.recheck.recheck(finding("f"));
    switched.select("/other");
    switched.resolve("wiki/a.md");
    expect(await afterSwitch).toBe(0);
    const disposed = setup();
    const afterDispose = disposed.recheck.recheck(finding("f"));
    disposed.recheck.dispose();
    disposed.resolve("wiki/a.md");
    expect(await afterDispose).toBe(0);
    expect(switched.enqueue).not.toHaveBeenCalled();
    expect(disposed.enqueue).not.toHaveBeenCalled();
    expect(await disposed.recheck.recheck(finding("f"))).toBe(0);
  });
});
