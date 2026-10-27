import type { createPackageScriptsController } from "../components/package-scripts-controller.svelte";
import type { SidebarIndicatorAction, SidebarIndicatorActionGroup, SidebarIndicatorActionId } from "./sidebar-indicator-actions";
import type { PackageTerminalView } from "./package-scripts";

type Controller = Pick<ReturnType<typeof createPackageScriptsController>,
  "loading" | "startingScript" | "terminalActionId" | "launchRuntimes" | "scriptRuntimes"
  | "launchCommands" | "snapshot" | "terminals" | "isTerminalBusy"
  | "runLaunchCommand" | "launchScript" | "stopProcess"> & {
    recentCommandRuns?: Readonly<Record<string, number>>;
  };

function isCommandTerminal(terminal: PackageTerminalView): boolean {
  return terminal.kind === "script" || Boolean(terminal.launchCommandId);
}

/** Avoid building runtime maps and menu handlers for every background output chunk. */
export function hasLaunchCommandMenu(controller: Controller): boolean {
  return controller.launchCommands.length > 0 || (controller.snapshot?.scripts.length ?? 0) > 0
    || controller.terminals.some((terminal) => isCommandTerminal(terminal) && controller.isTerminalBusy(terminal));
}

/** Use the panel's live owner, including foreground-job state rather than PTY liveness. */
export function launchCommandMenu(controller: Controller): {
  groups: readonly SidebarIndicatorActionGroup[];
  run: (id: SidebarIndicatorActionId) => boolean;
} {
  const actions: SidebarIndicatorAction[] = [];
  const handlers = new Map<SidebarIndicatorActionId, () => void>();
  const ranks = new Map<SidebarIndicatorActionId, number>();
  const disabled = controller.loading || controller.startingScript !== null || controller.terminalActionId !== null;
  let rank = 0;
  const add = (id: SidebarIndicatorActionId, commandName: string, icon: "play" | "stop", run: () => void) => {
    ranks.set(id, rank);
    actions.push({ id, label: `${icon === "play" ? "Run" : "Stop"} ${commandName}`, commandName, icon, disabled });
    handlers.set(id, run);
  };
  const launches = controller.launchRuntimes;
  const scripts = controller.scriptRuntimes;
  const busy = controller.terminals.filter((terminal) => isCommandTerminal(terminal) && controller.isTerminalBusy(terminal));
  const placed = new Set<string>();
  const addStops = (terminals: PackageTerminalView[], name: string): boolean => {
    for (const terminal of terminals) {
      placed.add(terminal.id);
      add(`scripts.command.stop:${terminal.id}`, name, "stop", () => { void controller.stopProcess(terminal.id); });
    }
    return terminals.length > 0;
  };
  for (const command of controller.launchCommands) {
    rank = controller.recentCommandRuns?.[`launch:${command.id}`] ?? 0;
    if (addStops(busy.filter((terminal) => terminal.launchCommandId === command.id), command.name)) continue;
    if (launches[command.id]?.state === "running") continue;
    add(`scripts.command.launch:${command.id}`, command.name, "play", () => { void controller.runLaunchCommand(command.id); });
  }
  for (const script of controller.snapshot?.scripts ?? []) {
    rank = controller.recentCommandRuns?.[`package:${script.name}`] ?? 0;
    if (addStops(busy.filter((terminal) => !terminal.launchCommandId && terminal.script === script.name), `${script.name} (package)`)) continue;
    if (scripts[script.name]?.state === "running") continue;
    add(`scripts.command.package:${script.name}`, `${script.name} (package)`, "play", () => { void controller.launchScript(script); });
  }
  rank = 0;
  for (const terminal of busy) {
    if (placed.has(terminal.id)) continue;
    const name = controller.launchCommands.find((command) => command.id === terminal.launchCommandId)?.name ?? terminal.script;
    add(`scripts.command.stop:${terminal.id}`, name, "stop", () => { void controller.stopProcess(terminal.id); });
  }
  actions.sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0));
  return {
    groups: actions.length ? [{ id: "scripts.commands", reason: "Launch commands", actions }] : [],
    run: (id) => {
      const handler = handlers.get(id);
      if (!handler || disabled) return false;
      handler();
      return true;
    },
  };
}
