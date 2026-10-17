export type PackageManagerKind = "npm" | "pnpm" | "yarn" | "bun";
export type PackageTerminalStatus = "running" | "exited" | "stopped" | "failed";
export type PackageTerminalKind = "script" | "shell";

export const PACKAGE_TERMINAL_OUTPUT_EVENT = "package-terminal://output";
export const PACKAGE_TERMINAL_EXIT_EVENT = "package-terminal://exit";
export const PACKAGE_TERMINAL_OUTPUT_MAX_CHARS = 512_000;

export interface PackageScript {
  readonly name: string;
  readonly command: string;
}

export interface PackageScriptsSnapshot {
  readonly packagePath: string;
  readonly exists: boolean;
  readonly packageName?: string;
  readonly packageManager: PackageManagerKind;
  readonly scripts: readonly PackageScript[];
}

export interface PackageTerminalSnapshot {
  readonly id: string;
  readonly kind: PackageTerminalKind;
  readonly script: string;
  readonly command: string;
  readonly launchCommandId?: string;
  readonly status: PackageTerminalStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly outputBase64: string;
  readonly startedAtMs: number;
}

export interface PackageTerminalOutputEvent {
  readonly terminalId: string;
  readonly dataBase64: string;
}

export interface PackageTerminalExitEvent {
  readonly terminalId: string;
  readonly status: PackageTerminalStatus;
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface PackageTerminalView extends PackageTerminalSnapshot {
  readonly output: string;
}

export function decodeBase64Bytes(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function terminalSnapshotView(snapshot: PackageTerminalSnapshot): PackageTerminalView {
  return {
    ...snapshot,
    output: new TextDecoder().decode(decodeBase64Bytes(snapshot.outputBase64)),
  };
}

export function packageManagerRunLabel(manager: PackageManagerKind, script: string): string {
  return `${manager} run ${script}`;
}

export function packageTerminalStatusLabel(terminal: Pick<PackageTerminalSnapshot, "status" | "exitCode" | "signal">): string {
  if (terminal.status === "running") return "Running";
  if (terminal.status === "stopped") return "Stopped";
  if (terminal.status === "failed") return "Failed";
  if (terminal.signal) return `Exited · ${terminal.signal}`;
  return terminal.exitCode === undefined ? "Exited" : `Exited · ${terminal.exitCode}`;
}

export function appendTerminalOutput(current: string, chunk: string, maxChars = PACKAGE_TERMINAL_OUTPUT_MAX_CHARS): string {
  const combined = `${current}${chunk}`;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

export interface PackageTerminalActivity {
  readonly id: string;
  readonly busy: boolean;
}

/** User-visible run state of a launch command or package script. */
export type LaunchRunState = "running" | "idle" | "succeeded" | "failed" | "stopped";

export interface LaunchRuntime {
  readonly terminalId: string;
  readonly state: LaunchRunState;
}

export function terminalRunState(terminal: PackageTerminalView, busy: boolean): LaunchRunState {
  if (terminal.status === "running") return terminal.kind === "script" || busy ? "running" : "idle";
  if (terminal.status === "failed") return "failed";
  if (terminal.status === "stopped") return "stopped";
  if (terminal.signal) return "stopped";
  return terminal.exitCode === undefined || terminal.exitCode === 0 ? "succeeded" : "failed";
}

/**
 * Pick the terminal that represents an item: a busy terminal wins, then an
 * idle live shell, then the most recent finished one.
 */
export function pickRuntimeTerminal(
  terminals: readonly PackageTerminalView[],
  matches: (terminal: PackageTerminalView) => boolean,
  isBusy: (terminal: PackageTerminalView) => boolean,
): PackageTerminalView | undefined {
  let best: PackageTerminalView | undefined;
  let bestRank = -1;
  for (const terminal of terminals) {
    if (!matches(terminal)) continue;
    const rank = terminal.status === "running" ? (isBusy(terminal) ? 2 : 1) : 0;
    if (rank >= bestRank) { best = terminal; bestRank = rank; }
  }
  return best;
}

export function filterPackageScripts(scripts: readonly PackageScript[], query: string): PackageScript[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...scripts];
  return scripts.filter((script) => script.name.toLowerCase().includes(needle));
}
