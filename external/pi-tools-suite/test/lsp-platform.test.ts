import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { controlLsp } from "../src/lsp/runtime-control";
import { releaseSharedLsp, sharedDiagnosticsForFile } from "../src/lsp/shared-manager";
import piLspExtension from "../src/lsp/index";

test("Windows TUI retains local diagnostics, controls and teardown without Unix IPC", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const state = globalThis as any;
  const previous = state.__piToolsSuiteLspManager;
  const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const cwd = mkdtempSync(path.join(artifacts, "lsp-platform-"));
  let shutdowns = 0;
  const fakeManager = {
    runtimeSnapshot: () => [{ id: "windows-local", root: cwd, state: "running", pid: 123 }],
    updateDiagnosticsForFile: async () => "local diagnostics",
    shutdownAll: async () => { shutdowns += 1; },
  };
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    state.__piToolsSuiteLspManager = fakeManager;
    const ctx = { cwd, hasUI: false, sessionManager: {}, ui: { notify: () => { throw new Error("Must not attempt Unix IPC"); } } } as any;
    expect((await controlLsp(ctx, "status")).servers).toContainEqual({ id: "windows-local", root: cwd, state: "running", pid: 123 });
    expect(await sharedDiagnosticsForFile(ctx, path.join(cwd, "a.ts"))).toBe("local diagnostics");
    await releaseSharedLsp(ctx);
    const handlers = new Map<string, any>();
    piLspExtension({ registerCommand() {}, on: (name: string, handler: unknown) => handlers.set(name, handler) } as any);
    await handlers.get("session_start")({}, ctx);
    await handlers.get("session_shutdown")({}, ctx);
    expect(shutdowns).toBe(3);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previous === undefined) delete state.__piToolsSuiteLspManager;
    else state.__piToolsSuiteLspManager = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});
