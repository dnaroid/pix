<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { onMount } from "svelte";
  import type { FitAddon } from "@xterm/addon-fit";
  import type { ILink, Terminal } from "@xterm/xterm";
  import { createTerminalViewLifetime, type TerminalViewLifetime } from "./terminal-view-lifetime";

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
  let scrollTrack: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let inputBuffer = "";
  let inputTimer: number | null = null;
  let resizeTimer: number | null = null;
  let scrollbarFrame = 0;
  let stopThumbDrag: (() => void) | undefined;
  let renderedControlledContent = "";
  let scrollbarVisible = $state(false);
  let scrollThumbTop = $state(0);
  let scrollThumbHeight = $state(0);

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
    terminal.options.cursorBlink = true;
    terminal.options.cursorInactiveStyle = "outline";
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
    const lifetime = createTerminalViewLifetime();
    let cleanup: (() => void) | undefined;

    void mountTerminal(lifetime).then((nextCleanup) => {
      if (!lifetime.isActive()) nextCleanup?.();
      else cleanup = nextCleanup;
    });

    return () => {
      lifetime.dispose();
      stopThumbDrag?.();
      cleanup?.();
    };
  });

  async function mountTerminal(lifetime: TerminalViewLifetime): Promise<(() => void) | undefined> {
    if (!container) return undefined;
    const [{ Terminal: TerminalConstructor }, { FitAddon: FitAddonConstructor }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    if (!lifetime.isActive() || !container?.isConnected) return undefined;
    const next = new TerminalConstructor({
      allowTransparency: false,
      convertEol,
      cursorBlink: true,
      cursorInactiveStyle: "outline",
      cursorStyle: "block",
      disableStdin: !running,
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontWeight: 400,
      fontWeightBold: 500,
      fontSize: 10,
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
            lifetime.resolveLinks(() => resolveLinks(line), (links) => {
              const resolved = (links ?? [])
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
            });
          },
        })
      : undefined;

    const dataDisposable = next.onData((data) => {
      if (!lifetime.isActive() || !running) return;
      inputBuffer += data;
      if (inputTimer !== null) return;
      inputTimer = lifetime.setTimeout(() => {
        inputTimer = null;
        flushInput();
      }, 8);
    });
    const resizeDisposable = next.onResize(({ cols, rows }) => {
      if (!lifetime.isActive()) return;
      scheduleTerminalChromeSync();
      if (resizeTimer !== null) lifetime.clearTimeout(resizeTimer);
      resizeTimer = lifetime.setTimeout(() => {
        resizeTimer = null;
        void onResize(cols, rows);
      }, 50);
    });
    const syncIfActive = () => { if (lifetime.isActive()) scheduleTerminalChromeSync(); };
    const scrollDisposable = next.onScroll(syncIfActive);
    const writeDisposable = next.onWriteParsed(syncIfActive);

    const fitTerminal = () => {
      if (!lifetime.isActive() || !container?.isConnected || !fitAddon || !terminal) return;
      try {
        terminal.options.theme = terminalTheme(container);
        fitAddon.fit();
        scheduleTerminalChromeSync();
      } catch {
        // The container can transiently have zero geometry while the sidebar resizes.
      }
    };
    const resizeObserver = new ResizeObserver(() => lifetime.scheduleFit(fitTerminal));
    resizeObserver.observe(container);
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    lifetime.listen(colorScheme, "change", fitTerminal);

    lifetime.scheduleInitial(() => {
      fitTerminal();
      if (content === undefined && initialContent) {
        next.write(initialContent);
      }
      next.scrollToBottom();
      if (running && focusWhenRunning) next.focus();
      scheduleTerminalChromeSync();
    });

    return () => {
      lifetime.dispose();
      cancelAnimationFrame(scrollbarFrame);
      scrollbarFrame = 0;
      flushInput();
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      writeDisposable.dispose();
      linkDisposable?.dispose();
      next.dispose();
      terminal = undefined;
      fitAddon = undefined;
      renderedControlledContent = "";
      scrollbarVisible = false;
    };
  }

  function scheduleTerminalChromeSync(): void {
    scheduleScrollbarSync();
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
    stopThumbDrag?.();
    const grabOffset = event.clientY - thumb.getBoundingClientRect().top;
    thumb.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === event.pointerId) scrollToPointer(moveEvent.clientY, grabOffset);
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      stopThumbDrag?.();
      if (running) terminal?.focus();
    };
    stopThumbDrag = () => {
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", finish);
      thumb.removeEventListener("pointercancel", finish);
      if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
      stopThumbDrag = undefined;
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
    return {
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground: value("--selection", foreground),
    };
  }
</script>

<div class="relative h-full min-h-0 min-w-0 w-full max-w-full bg-code">
  <div
    bind:this={container}
    class="terminal-host absolute inset-y-0 left-0 right-2 overflow-hidden bg-code font-mono text-foreground [&_.xterm]:h-full [&_.xterm]:max-w-full"
    role="application"
    aria-label={ariaLabel}
    data-terminal-readonly={!running}
    onpointerdown={() => { if (running) terminal?.focus(); }}
  ></div>
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
</style>
