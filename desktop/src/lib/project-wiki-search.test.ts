import { describe, expect, it, vi } from "vitest";
import type { NativeSearchHit, NativeSearchResponse } from "../../../external/pi-tools-suite/src/project-search/native-contract";
import { queryProjectWiki } from "./project-wiki-search";
import { SearchDialogController, type SearchDialogState } from "./search-dialog-controller";
import type { SearchSources } from "./universal-search";

const directory = "docs/game-wiki";
function hit(path = `${directory}/home.md`): NativeSearchHit {
  return { kind: "knowledge", id: path, path, title: "Page", snippet: "Page excerpt", startLine: 1, endLine: 3, score: 1 };
}
function response(hits = [hit()], status: Partial<NativeSearchResponse["status"]> = {}): NativeSearchResponse {
  return { hits, notices: [], status: { backend: "native", generation: 1, complete: true, stale: false, ...status } };
}
function fixture() {
  return {
    selection: vi.fn(async () => ({ enabled: { settings: false, sessions: false, tasks: false, commits: false, code: false, knowledge: true } })),
    repository: vi.fn<NonNullable<SearchSources["repository"]>>(async () => response()),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("Wiki Knowledge search", () => {
  it("scopes retrieval to the configured Wiki before both lexical and semantic work", async () => {
    const sources = fixture();
    const semantic = hit(`${directory}/ideas.md`);
    sources.repository.mockImplementation(async (_workspace, request) => response(
      request.mode === "hybrid" ? [semantic] : [hit()], { semanticEnabled: true },
    ));
    const update = vi.fn();
    const result = await queryProjectWiki(sources, "/project", directory, "project rules", new AbortController().signal, update);
    expect(sources.selection).toHaveBeenCalledWith("/project", expect.any(AbortSignal));
    expect(sources.repository.mock.calls.map(call => call[1].mode)).toEqual(["lexical", "hybrid"]);
    for (const [workspace, request] of sources.repository.mock.calls) {
      expect(workspace).toBe("/project");
      expect(request).toMatchObject({ sources: ["knowledge"], pathPrefix: directory, dedupeFile: true });
    }
    expect(update.mock.calls.some(([result]) => result.results[0]?.path === `${directory}/home.md`)).toBe(true);
    expect(result.results).toEqual([semantic]);
  });

  it("retains native reranking without embeddings and never adds a second reranking pass", async () => {
    const sources = fixture();
    sources.repository.mockImplementation(async () => response([hit()], { rerankerEnabled: true }));
    await queryProjectWiki(sources, "/project", directory, "rules", new AbortController().signal);
    expect(sources.repository.mock.calls.map(call => call[1].mode)).toEqual(["lexical", "hybrid"]);
    expect(sources.repository.mock.calls.every(call => call[1].skipRerank !== true)).toBe(true);
  });

  it("works locally without semantic configuration and rejects out-of-Wiki/source hits", async () => {
    const sources = fixture();
    sources.repository.mockResolvedValue(response([
      hit(), hit("wiki/page.md"), hit(`${directory}-other/page.md`),
      { ...hit(`${directory}/script.ts`), kind: "code" },
    ]));
    const result = await queryProjectWiki(sources, "/project", directory, "rules", new AbortController().signal);
    expect(result.results).toEqual([hit()]);
    expect(sources.repository).toHaveBeenCalledOnce();
  });

  it("does not silently enable a disabled Knowledge source or search on policy failure", async () => {
    const sources = fixture();
    const policy = await sources.selection();
    sources.selection.mockResolvedValue({ enabled: { ...policy.enabled, knowledge: false } });
    const disabled = await queryProjectWiki(sources, "/project", directory, "rules", new AbortController().signal);
    expect(disabled.results).toEqual([]);
    expect(disabled.notices.join()).toContain("disabled");
    sources.selection.mockRejectedValue(new Error("Cannot read policy"));
    const failed = await queryProjectWiki(sources, "/project", directory, "rules", new AbortController().signal);
    expect(failed.notices.join()).toContain("selection unavailable");
    expect(sources.repository).not.toHaveBeenCalled();
  });

  it("keeps lexical matches with a visible notice when enrichment fails", async () => {
    const sources = fixture();
    sources.repository.mockImplementation(async (_workspace, request) => {
      if (request.mode === "hybrid") throw new Error("Provider unavailable");
      return response([hit()], { semanticEnabled: true });
    });
    const result = await queryProjectWiki(sources, "/project", directory, "rules", new AbortController().signal);
    expect(result.results).toEqual([hit()]);
    expect(result.notices.join()).toContain("local matches retained");
  });

  it.each(["invalidate", "dispose"] as const)("%s aborts enrichment and suppresses late results", async action => {
    const sources = fixture();
    const enrichment = deferred<NativeSearchResponse>();
    sources.repository.mockImplementation(async (_workspace, request) => request.mode === "hybrid"
      ? enrichment.promise : response([hit()], { semanticEnabled: true }));
    const publish = vi.fn<(state: SearchDialogState) => void>();
    const controller = new SearchDialogController(
      (query, _types, signal, update) => queryProjectWiki(sources, "/project", directory, query, signal, update),
      undefined, publish,
    );
    const pending = controller.submit("rules", ["knowledge"]);
    await vi.waitFor(() => expect(sources.repository).toHaveBeenCalledTimes(2));
    controller[action]();
    const updates = publish.mock.calls.length;
    expect(sources.repository.mock.calls[1]![2].aborted).toBe(true);
    enrichment.resolve(response([hit(`${directory}/late.md`)]));
    await pending;
    expect(publish).toHaveBeenCalledTimes(updates);
    controller.dispose();
  });

  it("a superseded query cannot replace newer results even if its transport ignores abort", async () => {
    const sources = fixture();
    const previous = deferred<NativeSearchResponse>();
    sources.repository.mockImplementation(async (_workspace, request) => request.query === "old"
      ? previous.promise : response([hit(`${directory}/new.md`)]));
    const publish = vi.fn<(state: SearchDialogState) => void>();
    const controller = new SearchDialogController(
      (query, _types, signal, update) => queryProjectWiki(sources, "/project", directory, query, signal, update),
      undefined, publish,
    );
    const old = controller.submit("old", ["knowledge"]);
    await vi.waitFor(() => expect(sources.repository).toHaveBeenCalledOnce());
    await controller.submit("new", ["knowledge"]);
    previous.resolve(response());
    await old;
    expect(publish.mock.calls.at(-1)?.[0].result.results).toEqual([hit(`${directory}/new.md`)]);
    controller.dispose();
  });
});
