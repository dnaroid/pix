import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { LspRuntimeSnapshot } from "./runtime-control";

type Request = () => Promise<LspRuntimeSnapshot>;
type PanelResult = undefined;
const safeText = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

export function createLspPanel(request: Request, redraw: () => void, done: (result: PanelResult) => void): Component & { dispose(): void } {
  let snapshot: LspRuntimeSnapshot = { servers: [], warnings: [] };
  let selected = 0;
  let busy = false;
  let disposed = false;
  let error: string | undefined;

  async function refresh(): Promise<void> {
    if (busy || disposed) return;
    busy = true;
    redraw();
    try {
      const next = await request();
      if (disposed) return;
      const previous = snapshot.servers[selected];
      snapshot = next;
      const index = previous ? next.servers.findIndex((row) => row.id === previous.id && row.root === previous.root) : 0;
      selected = Math.max(0, index);
      error = undefined;
    } catch (cause) {
      if (!disposed) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      if (!disposed) redraw();
    }
  }

  const timer = setInterval(() => void refresh(), 4000);
  timer.unref?.();
  function dispose(): void { disposed = true; clearInterval(timer); }
  function finish(result: PanelResult): void { dispose(); done(result); }
  void refresh();
  return {
    invalidate() {},
    dispose,
    handleInput(data: string) {
      if (disposed) return;
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { finish(undefined); return; }
      if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
      else if (matchesKey(data, Key.down)) selected = Math.min(Math.max(0, snapshot.servers.length - 1), selected + 1);
      else if (data === "u") void refresh();
      redraw();
    },
    render(width: number) {
      const scope = process.platform === "win32" ? "session" : "project";
      const lifetime = process.platform === "win32" ? "Started by file edits; kept for reuse until this TUI closes." : "Started by file edits; kept for reuse until the last connected project session closes.";
      const lines = [`LSP · current ${scope}`, lifetime, "↑/↓ browse · u refresh · Esc close", ""];
      if (busy) lines.push("Working…");
      if (error) lines.push(`Error: ${error}`);
      for (const warning of snapshot.warnings) lines.push(`Warning: ${warning}`);
      if (!busy && snapshot.servers.length === 0) lines.push(`No running language servers for this ${scope}.`);
      const first = Math.max(0, selected - 5);
      for (let index = first; index < Math.min(snapshot.servers.length, first + 8); index++) {
        const row = snapshot.servers[index]!;
        lines.push(`${index === selected ? "›" : " "} ${row.id} · ${row.state}${row.pid === undefined ? "" : ` · PID ${row.pid}`}`);
        lines.push(`  ${row.root}`);
        if (row.error) lines.push(`  ${row.error}`);
      }
      if (snapshot.servers.length > 8) lines.push(`${selected + 1}/${snapshot.servers.length} servers`);
      return lines.map((line) => truncateToWidth(safeText(line), Math.max(1, width)));
    },
  };
}
