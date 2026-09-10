export type PackageManagerKind = "npm" | "pnpm" | "yarn" | "bun";
export type PackageTerminalStatus = "running" | "exited" | "stopped" | "failed";
export type PackageTerminalKind = "script" | "shell";

export const PACKAGE_TERMINAL_OUTPUT_EVENT = "package-terminal://output";
export const PACKAGE_TERMINAL_EXIT_EVENT = "package-terminal://exit";

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

export function appendTerminalOutput(current: string, chunk: string, maxChars = 512_000): string {
  const combined = `${current}${chunk}`;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

export function filterPackageScripts(scripts: readonly PackageScript[], query: string): PackageScript[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...scripts];
  return scripts.filter((script) => `${script.name}\n${script.command}`.toLowerCase().includes(needle));
}
