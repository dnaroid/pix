import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tick } from "svelte";
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
  let workspaceLoad: Promise<void> | undefined;

  $effect(() => {
    const requestWorkspace = options.workspace();
    const generation = ++loadGeneration;
    queueMicrotask(() => {
      if (generation !== loadGeneration) return;
      const pending = loadWorkspace(requestWorkspace, generation);
      workspaceLoad = pending;
      void pending.finally(() => {
        if (workspaceLoad === pending) workspaceLoad = undefined;
      });
    });
  });

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
      if (generation !== loadGeneration || options.workspace() !== requestWorkspace) return;
      snapshot = nextSnapshot;
      terminals = nextTerminals.map(terminalSnapshotView);
      terminalDecoders.clear();
      if (!terminals.some((terminal) => terminal.id === activeTerminalId)) {
        activeTerminalId = lastRunningTerminalId(terminals) ?? terminals.at(-1)?.id ?? null;
      }
    } catch (caught) {
      if (generation !== loadGeneration || options.workspace() !== requestWorkspace) return;
      error = errorMessage(caught);
      snapshot = undefined;
      terminals = [];
      activeTerminalId = null;
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function refresh(): void {
    const generation = ++loadGeneration;
    const pending = loadWorkspace(options.workspace(), generation);
    workspaceLoad = pending;
    void pending.finally(() => {
      if (workspaceLoad === pending) workspaceLoad = undefined;
    });
  }

  async function runScript(script: PackageScript): Promise<void> {
    const workspace = options.workspace();
    if (!workspace || startingScript || terminalActionId) return;
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
      terminals = [...terminals, terminalSnapshotView(started)];
      terminalDecoders.set(started.id, new TextDecoder());
      activeTerminalId = started.id;
      await tick();
      options.terminalView()?.focus();
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      startingScript = null;
    }
  }

  async function openShellTerminal(initialCommand?: string): Promise<void> {
    await tick();
    await workspaceLoad;
    const workspace = options.workspace();
    if (!workspace || startingScript || terminalActionId) return;
    startingScript = "__shell__";
    error = null;
    try {
      const size = options.terminalView()?.dimensions() ?? { cols: 80, rows: 24 };
      const started = await invoke<PackageTerminalSnapshot>("package_terminal_start_shell", {
        windowLabel,
        workspace,
        cols: size.cols,
        rows: size.rows,
      });
      terminals = [...terminals, terminalSnapshotView(started)];
      terminalDecoders.set(started.id, new TextDecoder());
      activeTerminalId = started.id;
      await tick();
      options.terminalView()?.focus();
      if (initialCommand?.trim()) {
        await writeTerminal(started.id, `${initialCommand}\r`);
      }
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      startingScript = null;
    }
  }

  async function writeTerminal(terminalId: string, data: string): Promise<void> {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal || terminal.status !== "running") return;
    try {
      await invoke("package_terminal_write", { windowLabel, terminalId, data });
    } catch (caught) {
      error = errorMessage(caught);
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
    if (terminal.status !== "running" || terminalActionId) return;
    terminalActionId = terminal.id;
    error = null;
    try {
      await invoke("package_terminal_stop", { windowLabel, terminalId: terminal.id });
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      terminalActionId = null;
    }
  }

  async function restartTerminal(terminal: PackageTerminalView): Promise<void> {
    if (terminalActionId || startingScript) return;
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
      terminals = terminals.filter((candidate) => candidate.id !== terminal.id);
      terminalDecoders.delete(terminal.id);
      activeTerminalId = terminals.at(-1)?.id ?? null;
      terminalActionId = null;
      if (terminal.kind === "shell") await openShellTerminal();
      else await runScript(script!);
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      terminalActionId = null;
    }
  }

  async function closeTerminal(terminal: PackageTerminalView): Promise<void> {
    if (terminalActionId) return;
    terminalActionId = terminal.id;
    error = null;
    try {
      if (terminal.status === "running") {
        await invoke("package_terminal_stop", { windowLabel, terminalId: terminal.id });
      }
      await invoke("package_terminal_forget", { windowLabel, terminalId: terminal.id });
      const index = terminals.findIndex((candidate) => candidate.id === terminal.id);
      terminals = terminals.filter((candidate) => candidate.id !== terminal.id);
      terminalDecoders.delete(terminal.id);
      if (activeTerminalId === terminal.id) {
        activeTerminalId = terminals[Math.min(index, terminals.length - 1)]?.id ?? terminals.at(-1)?.id ?? null;
      }
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      terminalActionId = null;
    }
  }

  async function selectTerminal(terminalId: string): Promise<void> {
    activeTerminalId = terminalId;
    await tick();
    options.terminalView()?.focus();
  }

  function start(): () => void {
    let disposed = false;
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
    }).catch((caught) => error = errorMessage(caught));

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
    }).catch((caught) => error = errorMessage(caught));

    return () => {
      disposed = true;
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
