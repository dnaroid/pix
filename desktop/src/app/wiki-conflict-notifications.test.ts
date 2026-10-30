import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { recordKnowledgeCheck } from "../../../acp/src/knowledge/stamp";
import type { ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";
import { createWikiConflictNotifications, MAX_WIKI_CONFLICT_GROUPS, MAX_WIKI_CONFLICT_GROUP_PAGES } from "./wiki-conflict-notifications";

const pass = "77777777-7777-4777-8777-777777777777";
const finding = {
  draft: { path: "wiki/page.md", quote: "Claim A.", startLine: 1, endLine: 1 },
  existing: { path: "wiki/source.md", quote: "Claim B.", startLine: 3, endLine: 3 },
  explanation: "The same rule differs.",
};
const result = (extra: Partial<KnowledgeCheckResult> = {}): KnowledgeCheckResult => ({
  status: "conflicts", path: "wiki/page.md", documentHash: "a".repeat(64), modelRef: "test/judge",
  checkedSources: 1, conflicts: [finding], notices: [], reportLanguage: "ru", ...extra,
});
const job = (extra: Partial<ProjectKnowledgeJob> = {}): ProjectKnowledgeJob => ({
  id: 1, workspace: "/project", path: "wiki/page.md", content: "Claim A.", expectedContent: "Claim A.",
  origin: "background", autoCheckRunId: pass, persistStamp: true,
  state: "completed", createdAt: 1, finishedAt: 2, result: result(), recorded: true, ...extra,
});
async function hash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function fixture(extra: Partial<Parameters<typeof createWikiConflictNotifications>[0]> = {}) {
  let workspace = "/project", generation = 0;
  const notify = vi.fn(), openPage = vi.fn(), openChecks = vi.fn(), reportError = vi.fn();
  const notifier = createWikiConflictNotifications({
    workspace: () => workspace, generation: () => generation, notify, openPage, openChecks, reportError, ...extra,
  });
  return {
    ...notifier, notify, openPage, openChecks, reportError,
    select(value: string) { workspace = value; generation++; },
    reset() { generation++; },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("Wiki conflict-only notifications", () => {
  it("is silent for green, incomplete, failed, cancelled and persistence-only failures", async () => {
    const item = fixture();
    for (const input of [
      job({ result: result({ status: "clear", conflicts: [] }) }),
      job({ result: result({ status: "incomplete", conflicts: [] }) }),
      job({ result: result({ status: "incomplete" }) }),
      job({ result: undefined, state: "failed", error: "Provider failed" }),
      job({ state: "cancelled" }),
      job({ result: result({ status: "clear", conflicts: [] }), recorded: false, error: "Disk changed" }),
      job({ result: result({ conflicts: [] }) }),
    ]) await item.complete(input);
    expect(item.notify).not.toHaveBeenCalled();
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("notifies only grounded conflicts as a sticky domain finding with page and list actions", async () => {
    const item = fixture();
    await item.complete(job({ recorded: false, error: "Could not store the report" }));
    expect(item.notify).toHaveBeenCalledOnce();
    const input = item.notify.mock.calls[0]![0];
    expect(input).toMatchObject({
      message: "В Wiki найдены возможные противоречия", detail: "wiki/page.md",
      source: "Wiki", log: false, durationMs: null,
    });
    expect(input.actions.map((action: { label: string }) => action.label)).toEqual(["Открыть страницу", "Все проверки"]);
    await input.actions[0].run();
    await input.actions[1].run();
    expect(item.openPage).toHaveBeenCalledExactlyOnceWith("wiki/page.md");
    expect(item.openChecks).toHaveBeenCalledOnce();
  });

  it("offers a Review action that opens the Wiki Conflicts tab for one page or the whole pass", async () => {
    const openConflicts = vi.fn();
    const item = fixture({ openConflicts });
    await item.complete(job());
    const single = item.notify.mock.calls[0]![0];
    expect(single.actions.map((action: { label: string }) => action.label)).toEqual(["Разобрать", "Открыть страницу", "Все проверки"]);
    await single.actions[0].run();
    expect(openConflicts).toHaveBeenLastCalledWith({ path: "wiki/page.md" });
    await item.complete(job({ id: 2, path: "wiki/second.md", result: result({ path: "wiki/second.md" }) }));
    const multiple = item.notify.mock.calls[1]![0];
    await multiple.actions[0].run();
    expect(openConflicts).toHaveBeenLastCalledWith({});
    item.reset();
    await multiple.actions[0].run();
    expect(openConflicts).toHaveBeenCalledTimes(2);
  });

  it("does not notify again when only explanation, model, line numbers or pass identity changes", async () => {
    const item = fixture();
    await item.complete(job());
    await item.complete(job({ id: 2, autoCheckRunId: "88888888-8888-4888-8888-888888888888", result: result({
      modelRef: "other/judge",
      conflicts: [{ ...finding, explanation: "A new paraphrase.", existing: { ...finding.existing, startLine: 9, endLine: 9 } }],
    }) }));
    expect(item.notify).toHaveBeenCalledOnce();
  });

  it("normalizes finding order and duplicate pairs without suppressing new quotations", async () => {
    const item = fixture();
    const another = { ...finding, existing: { ...finding.existing, quote: "Claim C." } };
    await item.complete(job({ result: result({ conflicts: [finding, another] }) }));
    await item.complete(job({ result: result({ conflicts: [another, finding, finding] }) }));
    expect(item.notify).toHaveBeenCalledOnce();
    await item.complete(job({ result: result({ conflicts: [{ ...finding, existing: { ...finding.existing, quote: "Claim D." } }] }) }));
    expect(item.notify).toHaveBeenCalledTimes(2);
  });

  it("compares original saved evidence to avoid repeats after restart or re-enabling", async () => {
    const body = "# Page\n\nClaim A.\n", documentHash = await hash(body);
    const previous = result({ documentHash });
    const raw = await recordKnowledgeCheck(body, previous, "2026-10-30T12:00:00.000Z");
    const item = fixture();
    await item.complete(job({ content: body, expectedContent: raw, result: {
      ...previous, modelRef: "next/model", conflicts: [{ ...finding, explanation: "Equivalent explanation." }],
    } }));
    expect(item.notify).not.toHaveBeenCalled();
    await item.complete(job({ content: body, expectedContent: raw, result: {
      ...previous, conflicts: [{ ...finding, existing: { ...finding.existing, quote: "Different evidence." } }],
    } }));
    expect(item.notify).toHaveBeenCalledOnce();
  });

  it("does not suppress a finding for a new body hash using a stale saved report", async () => {
    const before = "Claim A.\n", after = "Claim A.\nAnother rule.\n";
    const previous = result({ documentHash: await hash(before) });
    const raw = await recordKnowledgeCheck(before, previous);
    const stale = raw.slice(0, -before.length) + after;
    const item = fixture();
    await item.complete(job({ content: after, expectedContent: stale, result: result({ documentHash: await hash(after) }) }));
    expect(item.notify).toHaveBeenCalledOnce();
  });

  it("updates the same pass notification with distinct page counts and latest-page action", async () => {
    const item = fixture();
    await item.complete(job());
    await item.complete(job({ id: 2, path: "wiki/second.md", result: result({ path: "wiki/second.md" }) }));
    const [first, second] = item.notify.mock.calls.map(call => call[0]);
    expect(second.key).toBe(first.key);
    expect(second.message).toBe("В Wiki найдены противоречия · страниц: 2");
    expect(second.detail).toBe("wiki/second.md");
    expect(second.actions[0].label).toBe("Последняя страница");
    await second.actions[0].run();
    expect(item.openPage).toHaveBeenCalledExactlyOnceWith("wiki/second.md");
  });

  it("keeps different automatic passes separate while supporting ordinary manual checks", async () => {
    const item = fixture({ openChecks: undefined });
    await item.complete(job({ origin: "manual", autoCheckRunId: undefined }));
    await item.complete(job({ path: "wiki/next.md", result: result({ path: "wiki/next.md", reportLanguage: "en" }) }));
    const [manual, automatic] = item.notify.mock.calls.map(call => call[0]);
    expect(manual.key).not.toBe(automatic.key);
    expect(manual.actions).toHaveLength(1);
    expect(automatic.message).toBe("Potential Wiki contradictions found");
  });

  it("blocks stale async completion after a project round-trip or generation reset", async () => {
    const started = deferred<void>(), stored = deferred<undefined>();
    const item = fixture({ readReport: () => { started.resolve(); return stored.promise; } });
    const pending = item.complete(job());
    await started.promise;
    item.select("/other");
    item.select("/project");
    stored.resolve(undefined);
    await pending;
    expect(item.notify).not.toHaveBeenCalled();
    const ready = fixture();
    await ready.complete(job());
    const input = ready.notify.mock.calls[0]![0];
    ready.reset();
    await input.actions[0].run();
    await input.actions[1].run();
    expect(ready.openPage).not.toHaveBeenCalled();
    expect(ready.openChecks).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent arrivals without letting a duplicate release the first reservation", async () => {
    const started = deferred<void>(), stored = deferred<undefined>();
    const readReport = vi.fn(() => { started.resolve(); return stored.promise; });
    const item = fixture({ readReport });
    const first = item.complete(job());
    await started.promise;
    await item.complete(job({ id: 2 }));
    await item.complete(job({ id: 3 }));
    expect(readReport).toHaveBeenCalledOnce();
    stored.resolve(undefined);
    await first;
    expect(item.notify).toHaveBeenCalledOnce();
  });

  it("reports helper failures quietly without emitting an operational-error toast", async () => {
    const failure = new Error("Saved report could not be inspected");
    const item = fixture({ readReport: async () => { throw failure; } });
    await item.complete(job());
    expect(item.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(item.notify).not.toHaveBeenCalled();
  });

  it("bounds retained aggregation groups and page identities", async () => {
    const item = fixture({ readReport: async () => undefined });
    for (let index = 0; index <= MAX_WIKI_CONFLICT_GROUPS; index++) {
      const path = "wiki/pass-" + index + ".md";
      await item.complete(job({ path, autoCheckRunId: "pass-" + index, result: result({ path }) }));
    }
    await item.complete(job({ path: "wiki/old-pass.md", autoCheckRunId: "pass-0", result: result({ path: "wiki/old-pass.md" }) }));
    expect(item.notify.mock.calls.at(-1)![0].message).toBe("В Wiki найдены возможные противоречия");
    const many = fixture({ readReport: async () => undefined });
    for (let index = 0; index <= MAX_WIKI_CONFLICT_GROUP_PAGES; index++) {
      const path = "wiki/page-" + index + ".md";
      await many.complete(job({ path, result: result({ path }) }));
    }
    expect(many.notify.mock.calls.at(-1)![0].message).toContain(String(MAX_WIKI_CONFLICT_GROUP_PAGES) + "+");
  });
});
