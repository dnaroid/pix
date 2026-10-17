import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tick } from "svelte";
import { createTerminalInputWriter } from "../lib/terminal-input";
import type { ProjectFilePreview } from "../lib/project-files";
import { WORKSPACE_CONFIG_PATH } from "../lib/project-colors";
import { launchCommandsFromWorkspaceConfig, workspaceConfigWithLaunchCommands, type LaunchCommand } from "../lib/project-launch-commands";
import {
  appendTerminalOutput,
  decodeBase64Bytes,
  PACKAGE_TERMINAL_EXIT_EVENT,
  PACKAGE_TERMINAL_OUTPUT_EVENT,
  pickRuntimeTerminal,
  terminalRunState,
  terminalSnapshotView,
  type LaunchRuntime,
  type PackageScript,
  type PackageScriptsSnapshot,
  type PackageTerminalActivity,
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
  readonly afterWorkspaceSave?: (workspace: string) => void;
}

/** Shell busy state is sampled from the PTY foreground process group. */
const ACTIVITY_POLL_MS = 1_000;
const ACTIVITY_FOLLOW_UP_MS = 250;
/** Keep a just-launched command busy while the shell forks and execs it. */
const REUSED_SHELL_GRACE_MS = 1_500;
const FRESH_SHELL_GRACE_MS = 2_500;
/** Ctrl+C grace before an unresponsive foreground job is torn down with its shell. */
const INTERRUPT_GRACE_MS = 3_000;
/** Clear a partially typed line before injecting a command into a reused shell. */
const CLEAR_LINE = "\x15";

type InterruptOutcome = "idle" | "killed" | "failed";

export function createPackageScriptsController(options: PackageScriptsControllerOptions) {
  // Sidebar polling replaces its spread props even when the project is unchanged.
  // Compare the path before the owning effect, not the whole upstream props object.
  const workspace = $derived(options.workspace());
  const windowLabel = getCurrentWindow().label;
  const terminalDecoders = new Map<string, TextDecoder>();
  let snapshot = $state<PackageScriptsSnapshot | undefined>();
  let terminals = $state<PackageTerminalView[]>([]);
  let activeTerminalId = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let startingScript = $state<string | null>(null);
  let terminalActionId = $state<string | null>(null);
  let launchCommands = $state<LaunchCommand[]>([]);
  /** Live shells whose foreground job is not the shell itself. */
  let terminalBusy = $state<Record<string, boolean>>({});
  const busyGraceUntil = new Map<string, number>();
  let activitySeq = 0;
  let activityFailureLogged = false;
  let followUpTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let launchGeneration = 0;
  let loadGeneration = 0;
  let workspaceGeneration = 0;
  let disposed = false;
  let workspaceLoad: Promise<void> | undefined;
  let launchSaveTail: Promise<unknown> = Promise.resolve();
  let launchWorkspace = "";
  const inputWriter = createTerminalInputWriter(async (terminalId, data) => {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    if (disposed || !terminal || terminal.status !== "running") throw new Error("Terminal is no longer running");
    await invoke("package_terminal_write", { windowLabel, terminalId, data });
  });

  $effect(() => {
    const requestWorkspace = workspace;
    if (requestWorkspace !== launchWorkspace) {
      launchWorkspace = requestWorkspace;
      launchCommands = [];
      terminalDecoders.clear();
      terminalBusy = {};
      busyGraceUntil.clear();
      activitySeq += 1;
    }
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
    const savedGeneration = launchGeneration;
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
      void pollActivity();
      try {
        const exists = await invoke<boolean>("project_file_exists", { workspace: requestWorkspace, path: WORKSPACE_CONFIG_PATH });
        const settings = exists ? await invoke<ProjectFilePreview>("read_project_file", { workspace: requestWorkspace, path: WORKSPACE_CONFIG_PATH }) : undefined;
        if (disposed || generation !== loadGeneration || options.workspace() !== requestWorkspace) return;
        if (savedGeneration === launchGeneration) launchCommands = launchCommandsFromWorkspaceConfig(settings?.content);
      } catch (caught) {
        if (disposed || generation !== loadGeneration || options.workspace() !== requestWorkspace) return;
        error = errorMessage(caught);
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

  // Shell activity (busy/idle) tracking.

  /** Refresh which live shells are running a foreground job. Best-effort. */
  async function pollActivity(): Promise<void> {
    const requestWorkspace = options.workspace();
    if (disposed || !requestWorkspace) return;
    if (!terminals.some((terminal) => terminal.kind === "shell" && terminal.status === "running")) return;
    const seq = ++activitySeq;
    let activity: PackageTerminalActivity[] | undefined;
    try {
      activity = await invoke<PackageTerminalActivity[]>("package_terminal_activity", { windowLabel, workspace: requestWorkspace });
      activityFailureLogged = false;
    } catch (caught) {
      if (!activityFailureLogged && !disposed) {
        activityFailureLogged = true;
        console.warn("Failed to sample terminal activity", caught);
      }
      return;
    }
    if (disposed || seq !== activitySeq || options.workspace() !== requestWorkspace || !Array.isArray(activity)) return;
    const now = Date.now();
    const next: Record<string, boolean> = {};
    for (const item of activity) {
      const grace = busyGraceUntil.get(item.id);
      if (grace !== undefined && grace > now) next[item.id] = true;
      else {
        busyGraceUntil.delete(item.id);
        next[item.id] = item.busy;
      }
    }
    if (!sameBusyMap(terminalBusy, next)) terminalBusy = next;
  }

  function scheduleFollowUpPoll(): void {
    if (!started || disposed || followUpTimer !== undefined) return;
    followUpTimer = setTimeout(() => {
      followUpTimer = undefined;
      void pollActivity();
    }, ACTIVITY_FOLLOW_UP_MS);
  }

  function markBusy(terminalId: string, graceMs: number): void {
    busyGraceUntil.set(terminalId, Date.now() + graceMs);
    activitySeq += 1; // Discard samples taken before the command was injected.
    terminalBusy = { ...terminalBusy, [terminalId]: true };
  }

  function isBusy(terminal: PackageTerminalView): boolean {
    return terminal.status === "running" && (terminal.kind === "script" || terminalBusy[terminal.id] === true);
  }

  async function waitForIdle(terminalId: string, timeoutMs: number, isCurrent: () => boolean): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!isCurrent()) return false;
      await pollActivity();
      const terminal = terminals.find((candidate) => candidate.id === terminalId);
      if (!terminal || terminal.status !== "running" || !isBusy(terminal)) return true;
      if (Date.now() >= deadline) return false;
      await delay(150);
    }
  }

  // Launch command persistence.

  async function saveLaunchOperation(operation: (current: LaunchCommand[]) => LaunchCommand[]): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace) { error = "Open a project before saving launch commands."; return false; }
    const generation = workspaceGeneration;
    const previous = launchSaveTail;
    let release!: () => void;
    launchSaveTail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      if (disposed || generation !== workspaceGeneration || options.workspace() !== workspace) return false;
      const exists = await invoke<boolean>("project_file_exists", { workspace, path: WORKSPACE_CONFIG_PATH });
      let current = exists ? await invoke<ProjectFilePreview>("read_project_file", { workspace, path: WORKSPACE_CONFIG_PATH }) : undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (disposed || generation !== workspaceGeneration || options.workspace() !== workspace) return false;
        const commands = launchCommandsFromWorkspaceConfig(current?.content);
        const content = workspaceConfigWithLaunchCommands(current?.content, operation(commands));
        const result = await invoke<{ written: boolean; document: ProjectFilePreview | null }>("write_project_workspace_config_if_unchanged", { workspace, expectedContent: current?.content ?? null, content });
        if (disposed || generation !== workspaceGeneration || options.workspace() !== workspace) return false;
        if (result.written && result.document) { launchCommands = launchCommandsFromWorkspaceConfig(result.document.content); launchGeneration += 1; error = null; options.afterWorkspaceSave?.(workspace); return true; }
        current = result.document ?? undefined;
      }
      throw new Error(".pi/workspace.jsonc changed repeatedly. Try again.");
    } catch (caught) { if (!disposed && generation === workspaceGeneration && options.workspace() === workspace) error = errorMessage(caught); return false; }
    finally { release(); }
  }

  async function saveLaunchCommand(command: LaunchCommand): Promise<boolean> {
    if (!command.name.trim() || !command.command.trim()) { error = "Name and command are required."; return false; }
    return saveLaunchOperation((current) => [...current.filter((item) => item.id !== command.id), { ...command, name: command.name.trim(), command: command.command.trim() }]);
  }

  async function deleteLaunchCommand(id: string): Promise<boolean> { return saveLaunchOperation((current) => current.filter((item) => item.id !== id)); }

  // Launch commands: reuse a free shell instead of opening a new tab.

  async function runLaunchCommand(id: string): Promise<void> {
    await launchCommandIn(id);
  }

  async function launchCommandIn(id: string, preferredTerminalId?: string): Promise<void> {
    if (launchWorkspace && launchWorkspace !== options.workspace()) return;
    const { workspace, isCurrent } = captureWorkspace();
    if (!workspace || !isCurrent() || startingScript || terminalActionId) return;
    if (!launchCommands.some((item) => item.id === id)) { error = "Launch command no longer exists."; return; }
    startingScript = `launch:${id}`;
    error = null;
    try {
      await tick();
      await workspaceLoad;
      if (!isCurrent()) return;
      await pollActivity();
      if (!isCurrent()) return;
      const command = launchCommands.find((item) => item.id === id);
      if (!command) { error = "Launch command no longer exists."; return; }
      const liveShells = terminals.filter((terminal) => terminal.kind === "shell" && terminal.status === "running");
      const owned = liveShells.filter((terminal) => terminal.launchCommandId === id);
      // Like Zed: rerunning a task that is still running reveals it instead of
      // starting a duplicate. Restart is an explicit action.
      const running = lastMatching(owned, isBusy);
      if (running && running.id !== preferredTerminalId) {
        await focusTerminal(running.id, isCurrent);
        return;
      }
      const target = (preferredTerminalId ? liveShells.find((terminal) => terminal.id === preferredTerminalId && !isBusy(terminal)) : undefined)
        ?? lastMatching(owned, (terminal) => !isBusy(terminal))
        // Idle shells left by other launch commands are free; manual shells
        // without a launch command may hold interactive state and are not reused.
        ?? lastMatching(liveShells, (terminal) => Boolean(terminal.launchCommandId) && !isBusy(terminal));
      // Finished tabs of this command are superseded by the new run.
      await forgetFinished((terminal) => terminal.kind === "shell" && terminal.launchCommandId === id, isCurrent);
      if (!isCurrent()) return;
      if (!target) {
        await startShell(workspace, isCurrent, command.command, id);
        return;
      }
      if (target.launchCommandId !== id) {
        await invoke("package_terminal_assign_launch", { windowLabel, terminalId: target.id, launchCommandId: id });
        if (!isCurrent()) return;
        terminals = terminals.map((terminal) => terminal.id === target.id ? { ...terminal, launchCommandId: id } : terminal);
      }
      const live = terminals.find((terminal) => terminal.id === target.id);
      if (!live || live.status !== "running") {
        await startShell(workspace, isCurrent, command.command, id);
        return;
      }
      activeTerminalId = target.id;
      markBusy(target.id, REUSED_SHELL_GRACE_MS);
      await tick();
      if (!isCurrent()) return;
      if (activeTerminalId === target.id) options.terminalView()?.focus();
      await writeTerminal(target.id, `${CLEAR_LINE}${command.command}\r`);
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) startingScript = null;
    }
  }

  async function forgetFinished(matches: (terminal: PackageTerminalView) => boolean, isCurrent: () => boolean): Promise<void> {
    const finished = terminals.filter((terminal) => terminal.status !== "running" && matches(terminal));
    for (const terminal of finished) {
      try {
        await invoke("package_terminal_forget", { windowLabel, terminalId: terminal.id });
      } catch (caught) {
        console.warn("Failed to forget a finished terminal", terminal.id, caught);
        continue;
      }
      if (!isCurrent()) return;
      removeTerminal(terminal.id);
    }
  }

  function removeTerminal(terminalId: string): void {
    const index = terminals.findIndex((candidate) => candidate.id === terminalId);
    if (index < 0) return;
    terminals = terminals.filter((candidate) => candidate.id !== terminalId);
    terminalDecoders.delete(terminalId);
    busyGraceUntil.delete(terminalId);
    if (activeTerminalId === terminalId) {
      activeTerminalId = terminals[Math.min(index, terminals.length - 1)]?.id ?? terminals.at(-1)?.id ?? null;
    }
  }

  async function focusTerminal(terminalId: string, isCurrent: () => boolean): Promise<void> {
    activeTerminalId = terminalId;
    await tick();
    if (isCurrent() && activeTerminalId === terminalId) options.terminalView()?.focus();
  }

  function refresh(): void {
    if (disposed || loading) return;
    const generation = ++loadGeneration;
    const pending = loadWorkspace(options.workspace(), generation);
    workspaceLoad = pending;
    void pending.finally(() => {
      if (workspaceLoad === pending) workspaceLoad = undefined;
    });
  }

  // Package scripts.

  async function runScript(script: PackageScript): Promise<void> {
    const { workspace, isCurrent } = captureWorkspace();
    if (!workspace || !isCurrent() || startingScript || terminalActionId) return;
    startingScript = script.name;
    error = null;
    try {
      await startScriptTerminal(workspace, script, isCurrent);
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) startingScript = null;
    }
  }

  /** Reveal a running script, or replace its finished tab with a fresh run. */
  async function launchScript(script: PackageScript): Promise<void> {
    const { workspace, isCurrent } = captureWorkspace();
    if (!workspace || !isCurrent() || startingScript || terminalActionId) return;
    const matches = (terminal: PackageTerminalView) => terminal.kind === "script" && terminal.script === script.name;
    const running = lastMatching(terminals, (terminal) => matches(terminal) && terminal.status === "running");
    if (running) {
      await focusTerminal(running.id, isCurrent);
      return;
    }
    startingScript = script.name;
    error = null;
    try {
      await forgetFinished(matches, isCurrent);
      if (!isCurrent()) return;
      await startScriptTerminal(workspace, script, isCurrent);
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) startingScript = null;
    }
  }

  async function startScriptTerminal(workspace: string, script: PackageScript, isCurrent: () => boolean): Promise<void> {
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
  }

  // Shell terminals.

  async function openShellTerminal(initialCommand?: string, launchCommandId?: string): Promise<void> {
    const { workspace, isCurrent } = captureWorkspace();
    if (!workspace || !isCurrent() || startingScript || terminalActionId) return;
    startingScript = "__shell__";
    error = null;
    try {
      await tick();
      await workspaceLoad;
      if (!isCurrent()) return;
      await startShell(workspace, isCurrent, initialCommand, launchCommandId);
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) startingScript = null;
    }
  }

  /** Unguarded shell start; callers own the startingScript reservation. */
  async function startShell(workspace: string, isCurrent: () => boolean, initialCommand?: string, launchCommandId?: string): Promise<void> {
    const size = options.terminalView()?.dimensions() ?? { cols: 80, rows: 24 };
    const started = await invoke<PackageTerminalSnapshot>("package_terminal_start_shell", {
      windowLabel,
      workspace,
      launchCommandId: launchCommandId ?? null,
      cols: size.cols,
      rows: size.rows,
    });
    if (!isCurrent()) {
      await discardStartedTerminal(started.id);
      return;
    }
    const associated = launchCommandId && !started.launchCommandId
      ? { ...started, launchCommandId }
      : started;
    terminals = [...terminals, terminalSnapshotView(associated)];
    terminalDecoders.set(started.id, new TextDecoder());
    activeTerminalId = started.id;
    await tick();
    if (!isCurrent()) return;
    options.terminalView()?.focus();
    if (initialCommand?.trim()) {
      markBusy(started.id, FRESH_SHELL_GRACE_MS);
      await writeTerminal(started.id, `${initialCommand}\r`);
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

  /**
   * Stop the work in a terminal. A busy shell gets Ctrl+C so the shell stays
   * reusable; scripts and idle shells are stopped as before.
   */
  async function stopProcess(terminalId: string): Promise<void> {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal || terminal.status !== "running") return;
    if (terminal.kind === "shell" && isBusy(terminal)) {
      await interruptShell(terminal.id);
      return;
    }
    await stopTerminal(terminal);
  }

  async function interruptShell(terminalId: string): Promise<InterruptOutcome> {
    const { isCurrent } = captureWorkspace();
    if (!isCurrent() || terminalActionId || startingScript) return "failed";
    terminalActionId = terminalId;
    error = null;
    try {
      busyGraceUntil.delete(terminalId);
      await inputWriter.write(terminalId, "\x03");
      if (await waitForIdle(terminalId, INTERRUPT_GRACE_MS, isCurrent)) return isCurrent() ? "idle" : "failed";
      if (!isCurrent()) return "failed";
      // The foreground job ignored Ctrl+C: tear down the shell and its group.
      await invoke("package_terminal_stop", { windowLabel, terminalId });
      return isCurrent() ? "killed" : "failed";
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
      return "failed";
    } finally {
      if (isCurrent()) terminalActionId = null;
    }
  }

  /**
   * Restart the work in a terminal. A live launch-command shell is interrupted
   * and rerun in place; anything else is recreated.
   */
  async function restartProcess(terminalId: string): Promise<void> {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal) return;
    const launchId = terminal.launchCommandId;
    const reusable = terminal.kind === "shell" && terminal.status === "running"
      && launchId !== undefined && launchCommands.some((item) => item.id === launchId);
    if (!reusable) {
      await restartTerminal(terminal);
      return;
    }
    if (isBusy(terminal)) {
      const outcome = await interruptShell(terminal.id);
      if (outcome === "failed") return;
      if (outcome === "killed") {
        const latest = terminals.find((candidate) => candidate.id === terminal.id);
        if (latest) await restartTerminal(latest);
        return;
      }
    }
    await launchCommandIn(launchId, terminal.id);
  }

  async function restartTerminal(terminal: PackageTerminalView): Promise<void> {
    const { isCurrent } = captureWorkspace();
    if (!isCurrent() || terminalActionId || startingScript) return;
    const launchCommandId = terminal.launchCommandId;
    const launchCommand = launchCommands.find((item) => item.id === launchCommandId);
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
      busyGraceUntil.delete(terminal.id);
      activeTerminalId = terminals.at(-1)?.id ?? null;
      terminalActionId = null;
      if (terminal.kind === "shell") await openShellTerminal(launchCommand?.command, launchCommand?.id);
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
      removeTerminal(terminal.id);
    } catch (caught) {
      if (isCurrent()) error = errorMessage(caught);
    } finally {
      if (isCurrent()) terminalActionId = null;
    }
  }

  async function selectTerminal(terminalId: string): Promise<void> {
    const { isCurrent } = captureWorkspace();
    await focusTerminal(terminalId, isCurrent);
  }

  // Runtime views for the launcher rows.

  function runtimeFor(matches: (terminal: PackageTerminalView) => boolean): LaunchRuntime | undefined {
    const terminal = pickRuntimeTerminal(terminals, matches, isBusy);
    if (!terminal) return undefined;
    // A shell's exit code describes the shell, not the last launched command.
    const state = terminal.kind === "shell" && terminal.status !== "running"
      ? (terminal.status === "failed" ? "failed" : "stopped")
      : terminalRunState(terminal, isBusy(terminal));
    return { terminalId: terminal.id, state };
  }

  function start(): () => void {
    started = true;
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
      // A redrawn prompt usually means the foreground job just finished.
      if (terminal.kind === "shell" && terminalBusy[terminal.id]) scheduleFollowUpPoll();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }).catch((caught) => { if (!disposed) error = errorMessage(caught); });

    void listen<PackageTerminalExitEvent>(PACKAGE_TERMINAL_EXIT_EVENT, ({ payload }) => {
      if (disposed) return;
      const decoder = terminalDecoders.get(payload.terminalId);
      const trailing = decoder?.decode() ?? "";
      terminalDecoders.delete(payload.terminalId);
      busyGraceUntil.delete(payload.terminalId);
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

    const activityTimer = setInterval(() => { void pollActivity(); }, ACTIVITY_POLL_MS);

    return () => {
      disposed = true;
      workspaceGeneration += 1;
      loadGeneration += 1;
      clearInterval(activityTimer);
      if (followUpTimer !== undefined) clearTimeout(followUpTimer);
      followUpTimer = undefined;
      busyGraceUntil.clear();
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
    get runningCount() { return terminals.filter(isBusy).length; },
    get loading() { return loading; },
    get error() { return error; },
    get startingScript() { return startingScript; },
    get terminalActionId() { return terminalActionId; },
    /** Launch command id → the terminal that represents its latest run. */
    get launchRuntimes(): Record<string, LaunchRuntime> {
      const result: Record<string, LaunchRuntime> = {};
      for (const command of launchCommands) {
        const runtime = runtimeFor((terminal) => terminal.kind === "shell" && terminal.launchCommandId === command.id);
        if (runtime) result[command.id] = runtime;
      }
      return result;
    },
    /** Package script name → the terminal that represents its latest run. */
    get scriptRuntimes(): Record<string, LaunchRuntime> {
      const result: Record<string, LaunchRuntime> = {};
      for (const script of snapshot?.scripts ?? []) {
        const runtime = runtimeFor((terminal) => terminal.kind === "script" && terminal.script === script.name);
        if (runtime) result[script.name] = runtime;
      }
      return result;
    },
    isTerminalBusy: (terminal: PackageTerminalView) => isBusy(terminal),
    refresh,
    runScript,
    launchScript,
    get launchCommands() { return launchCommands; },
    saveLaunchCommand,
    deleteLaunchCommand,
    runLaunchCommand,
    openShellTerminal,
    writeTerminal,
    resizeTerminal,
    stopTerminal,
    stopProcess,
    restartTerminal,
    restartProcess,
    closeTerminal,
    selectTerminal,
    start,
  };
}

function lastMatching<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (predicate(item)) return item;
  }
  return undefined;
}

function lastRunningTerminalId(items: readonly PackageTerminalView[]): string | undefined {
  return lastMatching(items, (item) => item.status === "running")?.id;
}

function sameBusyMap(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
  const keys = Object.keys(right);
  if (Object.keys(left).length !== keys.length) return false;
  return keys.every((key) => left[key] === right[key]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
