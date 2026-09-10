<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { onMount } from "svelte";
  import type { FitAddon } from "@xterm/addon-fit";
  import type { Terminal } from "@xterm/xterm";

  let {
    initialContent = "",
    running,
    ariaLabel = "Package script terminal",
    onInput,
    onResize,
  }: {
    initialContent?: string;
    running: boolean;
    ariaLabel?: string;
    onInput: (data: string) => void | Promise<void>;
    onResize: (cols: number, rows: number) => void | Promise<void>;
  } = $props();

  let container: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let inputBuffer = "";
  let inputTimer: number | null = null;
  let resizeTimer: number | null = null;
  // Backend limits each IPC write to 64 KiB. 16K UTF-16 code units stays
  // comfortably below that even for multi-byte UTF-8 input/pastes.
  const MAX_INPUT_CHUNK_CHARS = 16 * 1024;

  export function write(data: string): void {
    if (data) terminal?.write(data);
  }

  export function clear(): void {
    terminal?.clear();
  }

  export function focus(): void {
    terminal?.focus();
  }

  export function dimensions(): { cols: number; rows: number } {
    return { cols: terminal?.cols ?? 80, rows: terminal?.rows ?? 24 };
  }

  $effect(() => {
    if (terminal) terminal.options.disableStdin = !running;
  });

  onMount(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void mountTerminal().then((nextCleanup) => {
      if (disposed) nextCleanup?.();
      else cleanup = nextCleanup;
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  });

  async function mountTerminal(): Promise<(() => void) | undefined> {
    if (!container) return undefined;
    const [{ Terminal: TerminalConstructor }, { FitAddon: FitAddonConstructor }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    if (!container?.isConnected) return undefined;
    const next = new TerminalConstructor({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: !running,
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontSize: 11,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      scrollback: 5_000,
      theme: terminalTheme(container),
    });
    const fit = new FitAddonConstructor();
    next.loadAddon(fit);
    next.open(container);
    terminal = next;
    fitAddon = fit;

    const dataDisposable = next.onData((data) => {
      if (!running) return;
      inputBuffer += data;
      if (inputTimer !== null) return;
      inputTimer = window.setTimeout(() => {
        inputTimer = null;
        flushInput();
      }, 8);
    });
    const resizeDisposable = next.onResize(({ cols, rows }) => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        void onResize(cols, rows);
      }, 50);
    });

    const fitTerminal = () => {
      if (!container?.isConnected || !fitAddon || !terminal) return;
      try {
        terminal.options.theme = terminalTheme(container);
        fitAddon.fit();
      } catch {
        // The container can transiently have zero geometry while the sidebar resizes.
      }
    };
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(fitTerminal));
    resizeObserver.observe(container);
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    colorScheme.addEventListener("change", fitTerminal);

    requestAnimationFrame(() => {
      fitTerminal();
      if (initialContent) next.write(initialContent);
      next.scrollToBottom();
      if (running) next.focus();
    });

    return () => {
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      flushInput();
      resizeObserver.disconnect();
      colorScheme.removeEventListener("change", fitTerminal);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      next.dispose();
      terminal = undefined;
      fitAddon = undefined;
    };
  }

  function flushInput(): void {
    if (!inputBuffer) return;
    const pending = inputBuffer;
    inputBuffer = "";
    for (let offset = 0; offset < pending.length; offset += MAX_INPUT_CHUNK_CHARS) {
      void onInput(pending.slice(offset, offset + MAX_INPUT_CHUNK_CHARS));
    }
  }

  function terminalTheme(node: HTMLElement) {
    const styles = getComputedStyle(node);
    const background = styles.backgroundColor;
    const foreground = styles.color;
    const value = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const primary = value("--primary", foreground);
    const muted = value("--muted-foreground", foreground);
    const error = value("--tool-error", foreground);
    const success = value("--tool-success", foreground);
    const warning = value("--tool-warning", foreground);
    const info = value("--tool-info", primary);
    const mutation = value("--tool-mutation", primary);
    const search = value("--tool-search", info);
    return {
      background,
      foreground,
      cursor: primary,
      cursorAccent: value("--primary-foreground", background),
      selectionBackground: colorWithAlpha(primary, 0.24),
      black: muted,
      red: error,
      green: success,
      yellow: warning,
      blue: info,
      magenta: mutation,
      cyan: search,
      white: foreground,
      brightBlack: muted,
      brightRed: error,
      brightGreen: success,
      brightYellow: warning,
      brightBlue: info,
      brightMagenta: mutation,
      brightCyan: search,
      brightWhite: foreground,
    };
  }

  function colorWithAlpha(color: string, alpha: number): string {
    if (/^#[0-9a-f]{6}$/iu.test(color)) {
      const red = Number.parseInt(color.slice(1, 3), 16);
      const green = Number.parseInt(color.slice(3, 5), 16);
      const blue = Number.parseInt(color.slice(5, 7), 16);
      return `rgb(${red} ${green} ${blue} / ${alpha})`;
    }
    return color;
  }
</script>

<div
  bind:this={container}
  class="h-full min-h-0 min-w-0 w-full max-w-full overflow-hidden bg-code text-foreground [&_.xterm]:h-full [&_.xterm]:max-w-full [&_.xterm-viewport]:!overflow-y-auto"
  role="application"
  aria-label={ariaLabel}
></div>
