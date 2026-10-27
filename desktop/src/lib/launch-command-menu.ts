import type { createPackageScriptsController } from "../components/package-scripts-controller.svelte";
import type { SidebarIndicatorAction, SidebarIndicatorActionGroup, SidebarIndicatorActionId } from "./sidebar-indicator-actions";
import type { PackageTerminalView } from "./package-scripts";

type Controller = Pick<ReturnType<typeof createPackageScriptsController>,
  "loading" | "startingScript" | "terminalActionId" | "launchRuntimes" | "scriptRuntimes"
  | "launchCommands" | "snapshot" | "terminals" | "isTerminalBusy"
  | "runLaunchCommand" | "launchScript" | "stopProcess">;

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
  const disabled = controller.loading || controller.startingScript !== null || controller.terminalActionId !== null;
  const add = (id: SidebarIndicatorActionId, label: string, run: () => void) => {
    actions.push({ id, label, disabled });
    handlers.set(id, run);
  };
  const launches = controller.launchRuntimes;
  const scripts = controller.scriptRuntimes;
  for (const command of controller.launchCommands) {
    if (launches[command.id]?.state === "running") continue;
    add(`scripts.command.launch:${command.id}`, `Run ${command.name}`, () => { void controller.runLaunchCommand(command.id); });
  }
  for (const script of controller.snapshot?.scripts ?? []) {
    if (scripts[script.name]?.state === "running") continue;
    add(`scripts.command.package:${script.name}`, `Run ${script.name} (package)`, () => { void controller.launchScript(script); });
  }
  for (const terminal of controller.terminals) {
    if (!isCommandTerminal(terminal) || !controller.isTerminalBusy(terminal)) continue;
    const name = controller.launchCommands.find((command) => command.id === terminal.launchCommandId)?.name ?? terminal.script;
    add(`scripts.command.stop:${terminal.id}`, `Stop ${name}`, () => { void controller.stopProcess(terminal.id); });
  }
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
