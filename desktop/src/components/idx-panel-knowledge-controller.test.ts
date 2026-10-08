import { describe, expect, it, vi } from "vitest";
import type { IdxCommandResult } from "../lib/idx";
import { createIdxPanelKnowledgeController } from "./idx-panel-knowledge-controller.svelte";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function deferred() {
  let resolve!: (result: IdxCommandResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<IdxCommandResult>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}
const result: IdxCommandResult = {
  stdout: JSON.stringify({ status: "dirty", counts: { clean: 0, dirty: 1, error: 0 }, warnings: [], specs: [{ path: "specs/a.md", status: "dirty", reasons: ["never-reviewed"], changedPaths: ["src/a.ts"] }] }),
  stderr: "", exitCode: 0, truncated: false,
};

describe("on-demand IDX knowledge details", () => {
  it("does no work on creation and requests details only explicitly, blocking maintenance/duplicates", async () => {
    invoke.mockReset();
    let operationRunning = true;
    const controller = createIdxPanelKnowledgeController({ workspace: () => "/repo", operationRunning: () => operationRunning });
    expect(invoke).not.toHaveBeenCalled();
    await controller.run();
    expect(invoke).not.toHaveBeenCalled();
    operationRunning = false;
    const pending = deferred();
    invoke.mockReturnValueOnce(pending.promise);
    const running = controller.run();
    await controller.run();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("idx_knowledge_status", { workspace: "/repo" });
    pending.resolve(result);
    await running;
    expect(controller.report?.specs[0]?.changedPaths).toEqual(["src/a.ts"]);
    expect(controller.state.running).toBe(false);
  });

  it("rejects stale completion after workspace change away and back, without clearing a newer request", async () => {
    let workspace = "/repo";
    const controller = createIdxPanelKnowledgeController({ workspace: () => workspace, operationRunning: () => false });
    const old = deferred();
    const newer = deferred();
    invoke.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const oldRun = controller.run();
    workspace = "/other";
    controller.invalidate();
    workspace = "/repo";
    controller.invalidate();
    const newRun = controller.run();
    old.resolve(result);
    await oldRun;
    expect(controller.report).toBeUndefined();
    expect(controller.state.running).toBe(true);
    newer.resolve(result);
    await newRun;
    expect(controller.report?.status).toBe("dirty");
  });

  it("drops pending errors on close/teardown and never invokes after disposal", async () => {
    const controller = createIdxPanelKnowledgeController({ workspace: () => "/repo", operationRunning: () => false });
    const pending = deferred();
    invoke.mockReset().mockReturnValueOnce(pending.promise);
    const running = controller.run();
    controller.dispose();
    pending.reject(new Error("stale failure"));
    await running;
    await controller.run();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(controller.error).toBe("");
    expect(controller.report).toBeUndefined();
  });

  it("shows failure without retaining an earlier complete report", async () => {
    const controller = createIdxPanelKnowledgeController({ workspace: () => "/repo", operationRunning: () => false });
    invoke.mockReset().mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, truncated: true });
    await controller.run();
    expect(controller.report?.status).toBe("dirty");
    await controller.run();
    expect(controller.report).toBeUndefined();
    expect(controller.error).toContain("incomplete");
  });
});
