import { beforeEach, describe, expect, it, vi } from "vitest";
import { LSP_ONBOARDING_CHANNEL } from "../lib/lsp-onboarding";
import { createLspOnboardingStore } from "./lsp-onboarding.svelte";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function notification(sessionId = "session-1") {
  return {
    sessionId,
    channel: LSP_ONBOARDING_CHANNEL,
    data: {
      version: 1,
      installerId: "python",
      languageId: "python",
      languageLabel: "Python",
      serverLabel: "Python LSP Server",
      path: "/project/src/main.py",
      checkedAt: 1,
    },
  };
}

function fixture() {
  let workspace = "/project";
  let activeSessionId: string | null = "session-1";
  let running = false;
  let agentState: "idle" | "pause-requested" | "paused" | "resuming" | "continuable" = "idle";
  let order = 0;
  const selectTab = vi.fn();
  const pause = vi.fn(async () => { agentState = "paused"; });
  const store = createLspOnboardingStore({
    workspace: () => workspace,
    activeSessionId: () => activeSessionId,
    promptRunning: () => running,
    agentState: () => agentState,
    pauseActiveAgent: pause,
    setActiveWorkbenchTabId: selectTab,
    nextWorkbenchAuxOrder: () => ++order,
  });
  return {
    store,
    pause,
    selectTab,
    setWorkspace(value: string) { workspace = value; },
    setRunning(value: boolean) { running = value; },
    setAgentState(value: typeof agentState) { agentState = value; },
    setActiveSession(value: string | null) { activeSessionId = value; },
  };
}

beforeEach(() => tauri.invoke.mockReset());

describe("Desktop LSP onboarding store", () => {
  it("dedupes one visible suggestion per session/language and honors Not now", () => {
    const { store } = fixture();
    expect(store.handleSessionState(notification())).toBe(true);
    expect(store.activeSuggestion()?.installerId).toBe("python");
    expect(store.handleSessionState({ ...notification(), data: { ...notification().data, checkedAt: 2 } })).toBe(true);
    expect(store.suggestions.size).toBe(1);

    store.dismiss("session-1");
    expect(store.activeSuggestion()).toBeUndefined();
    store.handleSessionState(notification());
    expect(store.activeSuggestion()).toBeUndefined();
  });

  it("pauses first, then installs/registers and leaves continuation to the user", async () => {
    const { store, pause, selectTab, setRunning, setAgentState } = fixture();
    setRunning(true);
    setAgentState("idle");
    store.handleSessionState(notification());
    tauri.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args.length === 0) return undefined;
      const command = args[0];
      if (command === "install_lsp_server") return {
        installerId: "python",
        bin: "/Users/me/.local/share/pix/lsp/python/bin/pylsp",
        env: {},
        output: "installed",
      };
      if (command === "read_user_config") return { content: "{}\n" };
      if (command === "write_user_config_if_unchanged") return { written: true, document: { content: "{}\n" } };
      throw new Error(`unexpected invoke: ${JSON.stringify(args)}`);
    });

    await store.pauseAndInstall("session-1");

    expect(pause).toHaveBeenCalledTimes(1);
    expect(selectTab).toHaveBeenCalledWith("lsp-install");
    expect(store.installer?.phase).toBe("success");
    expect(store.installer?.output).toBe("installed");
    expect(tauri.invoke).toHaveBeenCalledWith("install_lsp_server", { installerId: "python" });
  });

  it("clears a pause-pending install when its session is torn down", async () => {
    const { store, pause, setRunning, setAgentState } = fixture();
    setRunning(true);
    pause.mockImplementationOnce(async () => setAgentState("pause-requested"));
    store.handleSessionState(notification());

    await store.pauseAndInstall("session-1");
    expect(tauri.invoke).not.toHaveBeenCalledWith("install_lsp_server", expect.anything());

    store.clearSession("session-1");
    store.handleSessionState({ ...notification(), data: { ...notification().data, checkedAt: 3 } });
    expect(store.activeSuggestion()?.installerId).toBe("python");
  });

  it("serializes onboarding so a second session cannot replace an active installer", async () => {
    const { store, setActiveSession } = fixture();
    const installation = deferred<{ installerId: "python"; bin: string; env: {}; output: string }>();
    store.handleSessionState(notification("session-1"));
    tauri.invoke.mockImplementation((...args: unknown[]) => {
      if (args.length === 0) return undefined;
      const command = args[0];
      if (command === "install_lsp_server") return installation.promise;
      if (command === "read_user_config") return Promise.resolve({ content: "{}\n" });
      if (command === "write_user_config_if_unchanged") return Promise.resolve({ written: true, document: { content: "{}\n" } });
      throw new Error(`unexpected invoke: ${JSON.stringify(args)}`);
    });

    const first = store.pauseAndInstall("session-1");
    store.handleSessionState(notification("session-2"));
    setActiveSession("session-2");
    expect(store.activeSuggestion()).toBeUndefined();
    await store.pauseAndInstall("session-2");
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "install_lsp_server")).toHaveLength(1);

    installation.resolve({
      installerId: "python",
      bin: "/Users/me/.local/share/pix/lsp/python/bin/pylsp",
      env: {},
      output: "installed",
    });
    await first;
    expect(store.installer?.phase).toBe("success");
    expect(store.activeSuggestion()?.sessionId).toBe("session-2");
  });

  it("does not register a late installer completion after workspace reset", async () => {
    const { store } = fixture();
    const installation = deferred<{ installerId: "python"; bin: string; env: {}; output: string }>();
    store.handleSessionState(notification());
    tauri.invoke.mockImplementation((...args: unknown[]) => {
      if (args.length === 0) return undefined;
      const command = args[0];
      if (command === "install_lsp_server") return installation.promise;
      throw new Error(`unexpected invoke: ${JSON.stringify(args)}`);
    });

    const pending = store.pauseAndInstall("session-1");
    store.reset();
    installation.resolve({
      installerId: "python",
      bin: "/Users/me/.local/share/pix/lsp/python/bin/pylsp",
      env: {},
      output: "installed",
    });
    await pending;

    expect(tauri.invoke).not.toHaveBeenCalledWith("read_user_config", expect.anything());
    expect(store.installer).toBeNull();
  });
});
