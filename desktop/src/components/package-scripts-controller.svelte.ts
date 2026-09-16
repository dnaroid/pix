import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tick } from "svelte";
import { createTerminalInputWriter } from "../lib/terminal-input";
import {
  appendTerminalOutput,
  decodeBase64Bytes,
  PACKAGE_TERMINAL_EXIT_EVENT,
  PACKAGE_TERMINAL_OUTPUT_EVENT,
  terminalSnapshotView,
  type PackageScript,
  type PackageScriptsSnapshot,
  type PackageTerminalExitEvent,
  type PackageTerminalOutputEvent,
  type PackageTerminalSnapshot,
  type PackageTerminalView,
} from "../lib/package-scripts";

interface PackageTerminalSurface {
  write: (data: string) => void;
  focus: () => void;
  dimensions: () => { cols: number; rows: number };
}

interface PackageScriptsControllerOptions {
  readonly workspace: () => string;
  readonly terminalView: () => PackageTerminalSurface | null;
}

export function createPackageScriptsController(options: PackageScriptsControllerOptions) {
  const windowLabel = getCurrentWindow().label;
  const terminalDecoders = new Map<string, TextDecoder>();
  let snapshot = $state<PackageScriptsSnapshot | undefined>();
  let terminals = $state<PackageTerminalView[]>([]);
  let activeTerminalId = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let startingScript = $state<string | null>(null);
  let terminalActionId = $state<string | null>(null);
  let loadGeneration = 0;
  let workspaceGeneration = 0;
  let disposed = false;
  let workspaceLoad: Promise<void> | undefined;
  const inputWriter = createTerminalInputWriter(async (terminalId, data) => {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    if (disposed || !terminal || terminal.status !== "running") throw new Error("Terminal is no longer running");
    await invoke("package_terminal_write", { windowLabel, terminalId, data });
  });

  $effect(() => {
    const requestWorkspace = options.workspace();
    workspaceGeneration += 1;
    startingScript = null;
    terminalActionId = null;
    const generation = ++loadGeneration;
    queueMicrotask(() => {
      if (disposed || generation !== loadGeneration) return;
      const pending = loadWorkspace(requestWorkspace, generation);
      workspaceLoad = pending;
      void pending.finally(() => {
        if (workspaceLoad === pending) workspaceLoad = undefined;
      });
    });
    return () => {
      workspaceGeneration += 1;
      loadGeneration += 1;
    };
  });

  function captureWorkspace() {
    const workspace = options.workspace();
    const generation = workspaceGeneration;
    return {
      workspace,
      isCurrent: () => !disposed && workspaceGeneration === generation && options.workspace() === workspace,
    };
  }

  async function discardStartedTerminal(terminalId: string): Promise<void> {
    // A start may finish after workspace-wide teardown took its snapshot.
    // Reap that exact PTY rather than leaking it or adopting it in another project.
    try {
      await invoke("package_terminal_stop", { windowLabel, terminalId });
      await invoke("package_terminal_forget", { windowLabel, terminalId });
    } catch (caught) {
      console.error("Failed to discard an obsolete terminal", terminalId, caught);
    }
  }

  async function loadWorkspace(requestWorkspace: string, generation: number): Promise<void> {
    if (!requestWorkspace) {
      snapshot = undefined;
      terminals = [];
      activeTerminalId = null;
      error = null;
      loading = false;
      terminalDecoders.clear();
      return;
    }
    loading = true;
    error = null;
    try {
      const [nextSnapshot, nextTerminals] = await Promise.all([
        invoke<PackageScriptsSnapshot>("package_scripts", { workspace: requestWorkspace }),
        invoke<PackageTerminalSnapshot[]>("package_terminal_list", {
          windowLabel,
          workspace: requestWorkspace,
        }),
      ]);
      if (disposed || generation !== loadGeneration || options.workspace() !== requestWorkspace) return;
      snapshot = nextSnapshot;
      terminals = nextTerminals.map(terminalSnapshotView);
      terminalDecoders.clear();
      if (!terminals.some((terminal) => terminal.id === activeTerminalId)) {
        activeTerminalId = lastRunningTerminalId(terminals) ?? terminals.at(-1)?.id ?? null;
      }
    } catch (caught) {
      if (disposed || generation !== loadGeneration || options.workspace() !== requestWorkspace) return;
      error = errorMessage(caught);
      snapshot = undefined;
      terminals = [];
      activeTerminalId = null;
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function refresh(): void {
    if (disposed) return;
    const generation = ++loadGeneration;
    const pending = loadWorkspace(options.workspace(), generation);
    workspaceLoad = pending;
    void pending.finally(() => {
      if (workspaceLoad === pending) workspaceLoad = undefined;
    });
  }

  async function runScript(script: PackageScript): Promise<void> {
    const { workspace, isCurrent } = captureWorkspace();
    if (!workspace || !isCurrent() || startingScript || terminalActionId) return;
    startingScript = script.name;
    error = null;
    try {
      const size = options.terminalView()?.dimensions() ?? { cols: 80, rows: 24 };
      const started = await invoke<PackageTerminalSnapshot>("package_terminal_start", {
        windowLabel,
        workspace,
        script: script.name,
        cols: size.cols,
        rows: size.rows,
      });
      if (!isCurrent()) {
        await discardStartedTerminal(started.id);
        return;
      }
      terminals = [...terminals, terminalSnapshotView(started)];
      terminalDecoders.set(started.id, new TextDecoder());
      activeTerminalId = started.id;
      await tick();
      if (isCurrent() && activeTerminalId === started.id) options.terminalView()?.focus();
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) startingScript = null;
    }
  }

  async function openShellTerminal(initialCommand?: string): Promise<void> {
    const { workspace, isCurrent } = captureWorkspace();
    if (!workspace || !isCurrent() || startingScript || terminalActionId) return;
    startingScript = "__shell__";
    error = null;
    try {
      await tick();
      await workspaceLoad;
      if (!isCurrent()) return;
      const size = options.terminalView()?.dimensions() ?? { cols: 80, rows: 24 };
      const started = await invoke<PackageTerminalSnapshot>("package_terminal_start_shell", {
        windowLabel,
        workspace,
        cols: size.cols,
        rows: size.rows,
      });
      if (!isCurrent()) {
        await discardStartedTerminal(started.id);
        return;
      }
      terminals = [...terminals, terminalSnapshotView(started)];
      terminalDecoders.set(started.id, new TextDecoder());
      activeTerminalId = started.id;
      await tick();
      if (!isCurrent()) return;
      options.terminalView()?.focus();
      if (initialCommand?.trim()) {
        await writeTerminal(started.id, `${initialCommand}\r`);
      }
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) startingScript = null;
    }
  }

  async function writeTerminal(terminalId: string, data: string): Promise<void> {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal || terminal.status !== "running") return;
    try {
      await inputWriter.write(terminalId, data);
    } catch (caught) {
      if (!disposed && terminals.some((candidate) => candidate.id === terminalId)) error = errorMessage(caught);
    }
  }

  async function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal || terminal.status !== "running") return;
    try {
      await invoke("package_terminal_resize", { windowLabel, terminalId, cols, rows });
    } catch {
      // Resizing is best-effort while a process may be exiting.
    }
  }

  async function stopTerminal(terminal: PackageTerminalView): Promise<void> {
    const { isCurrent } = captureWorkspace();
    if (!isCurrent() || terminal.status !== "running" || terminalActionId || startingScript) return;
    terminalActionId = terminal.id;
    error = null;
    try {
      await invoke("package_terminal_stop", { windowLabel, terminalId: terminal.id });
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) terminalActionId = null;
    }
  }

  async function restartTerminal(terminal: PackageTerminalView): Promise<void> {
    const { isCurrent } = captureWorkspace();
    if (!isCurrent() || terminalActionId || startingScript) return;
    const script = terminal.kind === "script"
      ? snapshot?.scripts.find((candidate) => candidate.name === terminal.script)
      : undefined;
    if (terminal.kind === "script" && !script) {
      error = `Script ${terminal.script} is no longer present in package.json.`;
      return;
    }
    terminalActionId = terminal.id;
    error = null;
    try {
      if (terminal.status === "running") {
        await invoke("package_terminal_stop", { windowLabel, terminalId: terminal.id });
      }
      await invoke("package_terminal_forget", { windowLabel, terminalId: terminal.id });
      if (!isCurrent()) return;
      terminals = terminals.filter((candidate) => candidate.id !== terminal.id);
      terminalDecoders.delete(terminal.id);
      activeTerminalId = terminals.at(-1)?.id ?? null;
      terminalActionId = null;
      if (terminal.kind === "shell") await openShellTerminal();
      else await runScript(script!);
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) terminalActionId = null;
    }
  }

  async function closeTerminal(terminal: PackageTerminalView): Promise<void> {
    const { isCurrent } = captureWorkspace();
    if (!isCurrent() || terminalActionId || startingScript) return;
    terminalActionId = terminal.id;
    error = null;
    try {
      if (terminal.status === "running") {
        await invoke("package_terminal_stop", { windowLabel, terminalId: terminal.id });
      }
      await invoke("package_terminal_forget", { windowLabel, terminalId: terminal.id });
      if (!isCurrent()) return;
      const index = terminals.findIndex((candidate) => candidate.id === terminal.id);
      terminals = terminals.filter((candidate) => candidate.id !== terminal.id);
      terminalDecoders.delete(terminal.id);
      if (activeTerminalId === terminal.id) {
        activeTerminalId = terminals[Math.min(index, terminals.length - 1)]?.id ?? terminals.at(-1)?.id ?? null;
      }
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) terminalActionId = null;
    }
  }

  async function selectTerminal(terminalId: string): Promise<void> {
    const { isCurrent } = captureWorkspace();
    activeTerminalId = terminalId;
    await tick();
    if (isCurrent() && activeTerminalId === terminalId) options.terminalView()?.focus();
  }

  function start(): () => void {
    const unlisteners: Array<() => void> = [];
    void listen<PackageTerminalOutputEvent>(PACKAGE_TERMINAL_OUTPUT_EVENT, ({ payload }) => {
      if (disposed) return;
      const terminal = terminals.find((candidate) => candidate.id === payload.terminalId);
      if (!terminal) return;
      const decoder = terminalDecoders.get(payload.terminalId) ?? new TextDecoder();
      terminalDecoders.set(payload.terminalId, decoder);
      const chunk = decoder.decode(decodeBase64Bytes(payload.dataBase64), { stream: true });
      terminals = terminals.map((candidate) => candidate.id === payload.terminalId
        ? { ...candidate, output: appendTerminalOutput(candidate.output, chunk) }
        : candidate);
      if (payload.terminalId === activeTerminalId) options.terminalView()?.write(chunk);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }).catch((caught) => { if (!disposed) error = errorMessage(caught); });

    void listen<PackageTerminalExitEvent>(PACKAGE_TERMINAL_EXIT_EVENT, ({ payload }) => {
      if (disposed) return;
      const decoder = terminalDecoders.get(payload.terminalId);
      const trailing = decoder?.decode() ?? "";
      terminalDecoders.delete(payload.terminalId);
      if (trailing && payload.terminalId === activeTerminalId) options.terminalView()?.write(trailing);
      terminals = terminals.map((candidate) => candidate.id === payload.terminalId
        ? {
            ...candidate,
            output: trailing ? appendTerminalOutput(candidate.output, trailing) : candidate.output,
            status: payload.status,
            exitCode: payload.exitCode,
            signal: payload.signal,
          }
        : candidate);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }).catch((caught) => { if (!disposed) error = errorMessage(caught); });

    return () => {
      disposed = true;
      workspaceGeneration += 1;
      loadGeneration += 1;
      for (const unlisten of unlisteners) unlisten();
    };
  }

  return {
    get snapshot() { return snapshot; },
    get terminals() { return terminals; },
    get activeTerminalId() { return activeTerminalId; },
    get activeTerminal() {
      return activeTerminalId ? terminals.find((terminal) => terminal.id === activeTerminalId) : undefined;
    },
    get runningCount() { return terminals.filter((terminal) => terminal.status === "running").length; },
    get loading() { return loading; },
    get error() { return error; },
    get startingScript() { return startingScript; },
    get terminalActionId() { return terminalActionId; },
    refresh,
    runScript,
    openShellTerminal,
    writeTerminal,
    resizeTerminal,
    stopTerminal,
    restartTerminal,
    closeTerminal,
    selectTerminal,
    start,
  };
}

function lastRunningTerminalId(items: readonly PackageTerminalView[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.status === "running") return items[index]?.id;
  }
  return undefined;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
