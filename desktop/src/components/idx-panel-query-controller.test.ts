import { describe, expect, it, vi } from "vitest";
import { createIdxPanelQueryController } from "./idx-panel-query-controller.svelte";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("IDX v2 queries", () => {
  it("sends document-domain and context wire requests without legacy secondary options", async () => {
    let workspace = "/repo";
    const controller = createIdxPanelQueryController({ workspace: () => workspace, indexReady: () => true, operationRunning: () => false, setError: vi.fn() });
    invoke.mockReset().mockResolvedValue({ stdout: "answer", stderr: "", truncated: false });
    controller.state.queryText = "design";
    controller.state.queryKind = "knowledge";
    await controller.runQuery();
    expect(invoke).toHaveBeenCalledWith("idx_query", { request: { workspace, query: { kind: "knowledge", query: "design", limit: 5, pathPrefix: undefined } } });
    controller.state.queryKind = "context";
    controller.state.contextBudget = 2000;
    await controller.runQuery();
    expect(invoke).toHaveBeenLastCalledWith("idx_query", { request: { workspace, query: { kind: "context", query: "design", budget: 2000, maxSpecs: 4, maxCode: 6, maxTests: 4, pathPrefix: undefined } } });
    workspace = "/other";
    expect(controller.output).toBe("");
  });

  it("discards a late response from another workspace", async () => {
    let workspace = "/repo";
    let resolve!: (result: { stdout: string; stderr: string; truncated: boolean }) => void;
    invoke.mockReset().mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const controller = createIdxPanelQueryController({ workspace: () => workspace, indexReady: () => true, operationRunning: () => false, setError: vi.fn() });
    controller.state.queryText = "old";
    const pending = controller.runQuery();
    workspace = "/other";
    resolve({ stdout: "old result", stderr: "", truncated: false });
    await pending;
    expect(controller.output).toBe("");
    workspace = "/repo";
    expect(controller.output).toBe("");
  });
});
