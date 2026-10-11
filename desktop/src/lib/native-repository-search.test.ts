import { describe, expect, it, vi } from "vitest";
import { queryNativeRepository, indexNativeRepository } from "./native-repository-search";

describe("native repository transport", () => {
  it("sends an explicit source-only index operation with no synthetic query", async () => {
    const response = { source: "code", complete: false, indexed: 128, total: 900 };
    const invoke = vi.fn(async () => response);
    expect(await indexNativeRepository(invoke as any, "/workspace", "code", new AbortController().signal)).toEqual(response);
    expect(invoke).toHaveBeenCalledWith("native_project_search", { request: {
      workspace: "/workspace", requestId: expect.any(String), query: { operation: "index", source: "code" },
    } });
  });
  it("runs independently of an ACP session and sends only a typed request", async () => {
    const response = { hits: [], notices: [], status: { backend: "native", complete: true } };
    const invoke = vi.fn(async () => response);
    expect(await queryNativeRepository(invoke as any, "/workspace", { query: "needle", sources: ["code"] }, new AbortController().signal)).toBe(response);
    expect(invoke).toHaveBeenCalledWith("native_project_search", { request: {
      workspace: "/workspace", requestId: expect.any(String), query: { query: "needle", sources: ["code"] },
    } });
  });

  it("cancels the native owner and suppresses late results, without leaving an abort listener", async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn((command: string) => command.endsWith("cancel") ? Promise.resolve() : new Promise(resolve => { finish = resolve; }));
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const pending = queryNativeRepository(invoke as any, "/workspace", { query: "needle", sources: ["code"] }, abort.signal);
    abort.abort();
    finish({ hits: [] });
    await expect(pending).rejects.toThrow();
    const id = (invoke.mock.calls[0] as any)[1].request.requestId;
    expect(invoke).toHaveBeenLastCalledWith("native_project_search_cancel", { requestId: id });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("never starts an already cancelled request", async () => {
    const abort = new AbortController(); abort.abort();
    const invoke = vi.fn();
    await expect(queryNativeRepository(invoke, "/workspace", { query: "needle", sources: ["knowledge"] }, abort.signal)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
