import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Terminal as TerminalIcon, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

type PtyEvent = {
  id?: string;
  event?: "output" | "exit" | "error";
  data?: string;
  error?: string;
  status?: string;
};

type PtyStartResult = { id: string };

type RawTerminalProps = {
  cwd: string;
  command?: string;
  onClose: () => void;
};

export function RawTerminal({ cwd, command, onClose }: RawTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState("starting");

  const title = useMemo(() => {
    const trimmed = command?.trim();
    return trimmed ? `!! ${trimmed}` : "!! interactive shell";
  }, [command]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: "#181715",
        foreground: "#faf9f5",
        cursor: "#cc785c",
        selectionBackground: "#cc785c55",
        black: "#181715",
        red: "#c64545",
        green: "#5db872",
        yellow: "#e8a55a",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#5db8a6",
        white: "#faf9f5",
        brightBlack: "#737067",
        brightRed: "#ff6b6b",
        brightGreen: "#7bd88f",
        brightYellow: "#f0b866",
        brightBlue: "#9ab8ff",
        brightMagenta: "#d0adff",
        brightCyan: "#7ed9c8",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.focus();

    terminalRef.current = terminal;
    fitRef.current = fit;

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (event) => {
      if (event.event === "output" && event.data) {
        terminal.write(event.data);
        return;
      }
      if (event.event === "error") {
        terminal.writeln(`\r\n[pty error] ${event.error ?? "unknown error"}`);
        setStatus("error");
        return;
      }
      if (event.event === "exit") {
        terminal.writeln("\r\n[process exited]");
        setStatus("exited");
      }
    };

    const resize = () => {
      if (disposed) return;
      fit.fit();
      const id = ptyIdRef.current;
      if (!id) return;
      void invoke("pty_resize", { id, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    };

    const dataDisposable = terminal.onData((data) => {
      const id = ptyIdRef.current;
      if (!id) return;
      void invoke("pty_write", { id, data }).catch((error) => {
        terminal.writeln(`\r\n[pty write failed] ${String(error)}`);
      });
    });

    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const start = async () => {
      try {
        const result = await invoke<PtyStartResult>("pty_start", {
          opts: { cwd, command: command?.trim() || undefined, cols: terminal.cols, rows: terminal.rows },
          onEvent: channel,
        });
        if (disposed) {
          await invoke("pty_kill", { id: result.id }).catch(() => undefined);
          return;
        }
        ptyIdRef.current = result.id;
        setStatus("running");
        resize();
      } catch (error) {
        terminal.writeln(`[pty start failed] ${String(error)}`);
        setStatus("error");
      }
    };
    void start();

    return () => {
      disposed = true;
      observer.disconnect();
      dataDisposable.dispose();
      const id = ptyIdRef.current;
      if (id) void invoke("pty_kill", { id }).catch(() => undefined);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      ptyIdRef.current = null;
    };
  }, [command, cwd]);

  return (
    <section className="mx-4 mb-3 min-h-[260px] overflow-hidden rounded-xl border border-claude-dark-elevated bg-claude-dark text-claude-on-dark shadow-sm">
      <header className="flex h-10 items-center gap-2 border-b border-[#363430] px-3 text-xs">
        <TerminalIcon size={15} className="text-claude-coral" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono" title={title}>{title}</span>
        <span className="rounded-full border border-[#363430] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-claude-on-dark-soft">
          {status}
        </span>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-claude-on-dark-soft hover:bg-claude-dark-elevated hover:text-claude-on-dark focus:outline-none focus:ring-2 focus:ring-claude-coral"
          onClick={onClose}
          aria-label="Close raw terminal"
          title="Close raw terminal"
        >
          <X size={14} />
        </button>
      </header>
      <div ref={hostRef} className="h-[300px] p-2" />
    </section>
  );
}
