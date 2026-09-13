export type DesktopTerminalCommand =
  | { readonly kind: "chat"; readonly command: string }
  | { readonly kind: "interactive"; readonly command: string };

/** Parse the TUI-compatible `!` / `!!` composer prefixes. */
export function parseDesktopTerminalCommand(text: string): DesktopTerminalCommand | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("!")) return undefined;
  const interactive = trimmed.startsWith("!!");
  const command = trimmed.slice(interactive ? 2 : 1).trim();
  if (!command) return undefined;
  return { kind: interactive ? "interactive" : "chat", command };
}
