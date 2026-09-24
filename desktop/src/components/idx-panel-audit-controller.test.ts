import { describe, expect, it, vi } from "vitest";
import { createIdxPanelAuditController } from "./idx-panel-audit-controller.svelte";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("IDX task audit", () => {
  it("never invokes a blank or escaping audit, and passes explicit deduplicated task paths", async () => {
    let workspace = "/repo";
    const setError = vi.fn();
    const controller = createIdxPanelAuditController({ workspace: () => workspace, indexReady: () => true, operationRunning: () => false, setError });
    invoke.mockReset().mockResolvedValue({ stdout: "done", stderr: "", truncated: false });
    await controller.run();
    expect(invoke).not.toHaveBeenCalled();
    controller.state.pathsInput = "../outside";
    await controller.run();
    expect(invoke).not.toHaveBeenCalled();
    controller.state.pathsInput = "src/one.ts, specs/two.md\nsrc/one.ts";
    await controller.run();
    expect(invoke).toHaveBeenCalledWith("idx_audit", { request: { workspace, paths: ["src/one.ts", "specs/two.md"] } });
    expect(controller.output).toBe("done");
    workspace = "/another-repo";
    expect(controller.output).toBe("");
  });

  it("does not display an in-flight result after switching workspaces or changing task paths", async () => {
    let workspace = "/repo";
    const setError = vi.fn();
    const controller = createIdxPanelAuditController({ workspace: () => workspace, indexReady: () => true, operationRunning: () => false, setError });
    const pending = deferred<{ stdout: string; stderr: string; truncated: boolean }>();
    invoke.mockReset().mockReturnValueOnce(pending.promise);
    controller.state.pathsInput = "src/old.ts";
    const running = controller.run();
    workspace = "/new-repo";
    pending.resolve({ stdout: "old result", stderr: "", truncated: false });
    await running;
    expect(controller.output).toBe("");
    expect(setError).not.toHaveBeenCalledWith("old result");
    workspace = "/repo";
    expect(controller.output).toBe("");
    controller.state.pathsInput = "src/new.ts";
    expect(controller.output).toBe("");
  });

  it("invalidates an in-flight audit even if paths are changed away and back", async () => {
    const pending = deferred<{ stdout: string; stderr: string; truncated: boolean }>();
    invoke.mockReset().mockReturnValueOnce(pending.promise);
    const setError = vi.fn();
    const controller = createIdxPanelAuditController({ workspace: () => "/repo", indexReady: () => true, operationRunning: () => false, setError });
    controller.setPathsInput("src/one.ts");
    const running = controller.run();
    controller.setPathsInput("src/two.ts");
    controller.setPathsInput("src/one.ts");
    pending.resolve({ stdout: "stale", stderr: "", truncated: false });
    await running;
    expect(controller.output).toBe("");
    expect(controller.state.running).toBe(false);
  });
});
