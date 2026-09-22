<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { onMount } from "svelte";
  import type { FitAddon } from "@xterm/addon-fit";
  import type { ILink, Terminal } from "@xterm/xterm";
  import { createAnimationFrameCoalescer } from "../lib/animation-frame-coalescer";

  type TerminalTextLink = {
    startIndex: number;
    endIndex: number;
    text: string;
    activate: () => void | Promise<void>;
  };

  const TERMINAL_SCROLLBACK_LINES = 5_000;

  let {
    initialContent = "",
    content,
    running,
    ariaLabel = "Package script terminal",
    focusWhenRunning = true,
    convertEol = false,
    onInput = () => {},
    onResize = () => {},
    resolveLinks,
  }: {
    initialContent?: string;
    /**
     * Optional controlled output mode. When provided, appended content is
     * streamed into xterm and non-prefix replacements reset the buffer.
     */
    content?: string;
    running: boolean;
    ariaLabel?: string;
    focusWhenRunning?: boolean;
    /** Convert bare LF output to CRLF. Useful for pipe/log output; PTYs already emit terminal cursor control. */
    convertEol?: boolean;
    onInput?: (data: string) => void | Promise<void>;
    onResize?: (cols: number, rows: number) => void | Promise<void>;
    resolveLinks?: (line: string) => readonly TerminalTextLink[] | Promise<readonly TerminalTextLink[]>;
  } = $props();

  let container: HTMLDivElement | undefined;
  let terminalFrame: HTMLDivElement | undefined;
  let scrollTrack: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let inputBuffer = "";
  let inputTimer: number | null = null;
  let resizeTimer: number | null = null;
  let scrollbarFrame = 0;
  let renderedControlledContent = "";
  let scrollbarVisible = $state(false);
  let scrollThumbTop = $state(0);
  let scrollThumbHeight = $state(0);
  let caretVisible = $state(false);
  let caretLeft = $state(0);
  let caretTop = $state(0);
  let caretHeight = $state(0);
  const caretSync = createAnimationFrameCoalescer(syncCaret);

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
    if (!terminal) return;
    terminal.options.disableStdin = !running;
    terminal.options.cursorBlink = false;
    terminal.options.cursorInactiveStyle = "none";
    terminal.options.convertEol = convertEol;
    scheduleTerminalChromeSync();
  });

  $effect(() => {
    const nextContent = content;
    const currentTerminal = terminal;
    if (nextContent === undefined || !currentTerminal) return;

    if (nextContent.startsWith(renderedControlledContent)) {
      const appended = nextContent.slice(renderedControlledContent.length);
      if (appended) currentTerminal.write(appended);
    } else {
      currentTerminal.reset();
      if (nextContent) currentTerminal.write(nextContent);
    }
    renderedControlledContent = nextContent;
    currentTerminal.scrollToBottom();
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
      convertEol,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      cursorStyle: "bar",
      cursorWidth: 2,
      disableStdin: !running,
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: terminalTheme(container),
    });
    const fit = new FitAddonConstructor();
    next.loadAddon(fit);
    next.open(container);
    terminal = next;
    fitAddon = fit;

    if (content !== undefined) {
      renderedControlledContent = content;
      if (content) next.write(content);
    }

    const linkDisposable = resolveLinks
      ? next.registerLinkProvider({
          provideLinks(bufferLineNumber, callback): void {
            const line = next.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) ?? "";
            void Promise.resolve(resolveLinks(line))
              .then((links) => {
                const resolved = links
                  .filter((link) => link.startIndex >= 0 && link.endIndex > link.startIndex)
                  .map<ILink>((link) => ({
                    range: {
                      start: { x: link.startIndex + 1, y: bufferLineNumber },
                      end: { x: link.endIndex, y: bufferLineNumber },
                    },
                    text: link.text,
                    activate: () => void link.activate(),
                  }));
                callback(resolved.length > 0 ? resolved : undefined);
              })
              .catch(() => callback(undefined));
          },
        })
      : undefined;

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
      scheduleTerminalChromeSync();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        void onResize(cols, rows);
      }, 50);
    });
    const scrollDisposable = next.onScroll(() => scheduleTerminalChromeSync());
    const writeDisposable = next.onWriteParsed(() => scheduleTerminalChromeSync());
    const cursorDisposable = next.onCursorMove(() => scheduleTerminalChromeSync());

    const fitTerminal = () => {
      if (!container?.isConnected || !fitAddon || !terminal) return;
      try {
        terminal.options.theme = terminalTheme(container);
        fitAddon.fit();
        scheduleTerminalChromeSync();
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
      if (content === undefined && initialContent) {
        next.write(initialContent);
      }
      next.scrollToBottom();
      if (running && focusWhenRunning) next.focus();
      scheduleTerminalChromeSync();
    });

    return () => {
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      cancelAnimationFrame(scrollbarFrame);
      scrollbarFrame = 0;
      caretSync.cancel();
      flushInput();
      resizeObserver.disconnect();
      colorScheme.removeEventListener("change", fitTerminal);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      writeDisposable.dispose();
      cursorDisposable.dispose();
      linkDisposable?.dispose();
      next.dispose();
      terminal = undefined;
      fitAddon = undefined;
      renderedControlledContent = "";
      scrollbarVisible = false;
      caretVisible = false;
    };
  }

  function scheduleTerminalChromeSync(): void {
    scheduleScrollbarSync();
    caretSync.schedule();
  }

  function scheduleScrollbarSync(): void {
    cancelAnimationFrame(scrollbarFrame);
    scrollbarFrame = requestAnimationFrame(syncScrollbar);
  }

  function syncScrollbar(): void {
    scrollbarFrame = 0;
    const currentTerminal = terminal;
    const track = scrollTrack;
    if (!currentTerminal || !track) {
      scrollbarVisible = false;
      return;
    }
    const buffer = currentTerminal.buffer.active;
    const maxViewportY = Math.max(0, buffer.baseY);
    const trackHeight = track.clientHeight;
    if (maxViewportY <= 0 || trackHeight <= 0) {
      scrollbarVisible = false;
      scrollThumbTop = 0;
      scrollThumbHeight = trackHeight;
      return;
    }
    const totalRows = maxViewportY + currentTerminal.rows;
    const thumbHeight = Math.max(24, Math.min(trackHeight, Math.round(trackHeight * currentTerminal.rows / totalRows)));
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    scrollbarVisible = true;
    scrollThumbHeight = thumbHeight;
    scrollThumbTop = maxThumbTop === 0 ? 0 : Math.round(maxThumbTop * buffer.viewportY / maxViewportY);
  }

  function syncCaret(): void {
    const currentTerminal = terminal;
    const frame = terminalFrame;
    const terminalElement = currentTerminal?.element;
    const screen = terminalElement?.querySelector<HTMLElement>(".xterm-screen");
    if (!running || !currentTerminal || !frame || !screen || currentTerminal.cols <= 0 || currentTerminal.rows <= 0) {
      caretVisible = false;
      return;
    }

    const frameRect = frame.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    if (screenRect.width <= 0 || screenRect.height <= 0) {
      caretVisible = false;
      return;
    }

    const cellWidth = screenRect.width / currentTerminal.cols;
    const cellHeight = screenRect.height / currentTerminal.rows;
    const cursorX = Math.max(0, Math.min(currentTerminal.cols - 1, currentTerminal.buffer.active.cursorX));
    const cursorY = Math.max(0, Math.min(currentTerminal.rows - 1, currentTerminal.buffer.active.cursorY));
    caretLeft = screenRect.left - frameRect.left + cursorX * cellWidth;
    caretTop = screenRect.top - frameRect.top + cursorY * cellHeight;
    caretHeight = cellHeight;
    caretVisible = true;
  }

  function scrollToPointer(clientY: number, grabOffset = scrollThumbHeight / 2): void {
    const currentTerminal = terminal;
    const track = scrollTrack;
    if (!currentTerminal || !track) return;
    const maxViewportY = Math.max(0, currentTerminal.buffer.active.baseY);
    const maxThumbTop = Math.max(0, track.clientHeight - scrollThumbHeight);
    if (maxViewportY <= 0 || maxThumbTop <= 0) return;
    const desiredTop = Math.max(0, Math.min(maxThumbTop, clientY - track.getBoundingClientRect().top - grabOffset));
    currentTerminal.scrollToLine(Math.round(maxViewportY * desiredTop / maxThumbTop));
    scheduleScrollbarSync();
  }

  function handleScrollTrackPointerDown(event: PointerEvent): void {
    if (!scrollbarVisible || event.target !== event.currentTarget) return;
    event.preventDefault();
    scrollToPointer(event.clientY);
    if (running) terminal?.focus();
  }

  function handleScrollThumbPointerDown(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const thumb = event.currentTarget as HTMLDivElement;
    const grabOffset = event.clientY - thumb.getBoundingClientRect().top;
    thumb.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === event.pointerId) scrollToPointer(moveEvent.clientY, grabOffset);
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", finish);
      thumb.removeEventListener("pointercancel", finish);
      if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
      if (running) terminal?.focus();
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", finish);
    thumb.addEventListener("pointercancel", finish);
  }

  function flushInput(): void {
    if (!inputBuffer) return;
    const pending = inputBuffer;
    inputBuffer = "";
    // The controller serializes/chunks per PTY, including programmatic input.
    void onInput(pending);
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

<div bind:this={terminalFrame} class="relative h-full min-h-0 min-w-0 w-full max-w-full bg-code">
  <div
    bind:this={container}
    class="terminal-host absolute inset-y-0 left-0 right-2 overflow-hidden bg-code text-foreground [&_.xterm]:h-full [&_.xterm]:max-w-full"
    role="application"
    aria-label={ariaLabel}
    data-terminal-readonly={!running}
    onpointerdown={() => { if (running) terminal?.focus(); }}
  ></div>
  {#if caretVisible}
    <div
      class="pointer-events-none absolute z-10 w-0.5 bg-primary"
      style:left={`${caretLeft}px`}
      style:top={`${caretTop}px`}
      style:height={`${caretHeight}px`}
      aria-hidden="true"
      data-terminal-caret
    ></div>
  {/if}
  <div
    bind:this={scrollTrack}
    class="absolute top-1 right-0 bottom-1 w-2 cursor-default rounded-full bg-border/25"
    aria-hidden="true"
    onpointerdown={handleScrollTrackPointerDown}
  >
    {#if scrollbarVisible}
      <div
        class="absolute right-0.5 w-1.5 cursor-default rounded-full bg-muted-foreground/45 transition-colors hover:bg-muted-foreground/70"
        style:top={`${scrollThumbTop}px`}
        style:height={`${scrollThumbHeight}px`}
        role="presentation"
        onpointerdown={handleScrollThumbPointerDown}
      ></div>
    {/if}
  </div>
</div>

<style>
  :global(.terminal-host .xterm-viewport) {
    scrollbar-width: none;
  }

  :global(.terminal-host .xterm-viewport::-webkit-scrollbar) {
    width: 0;
    height: 0;
  }

  :global(.terminal-host .xterm-cursor) {
    background: transparent !important;
    border: 0 !important;
    box-shadow: none !important;
    outline: 0 !important;
  }
</style>
