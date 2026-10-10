<script lang="ts">
  import Code2 from "@lucide/svelte/icons/code-2";
  import Maximize2 from "@lucide/svelte/icons/maximize-2";
  import Minimize2 from "@lucide/svelte/icons/minimize-2";
  import Play from "@lucide/svelte/icons/play";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import Square from "@lucide/svelte/icons/square";
  import { onDestroy } from "svelte";
  import {
    HTML_SANDBOX_CHANNEL,
    parseHtmlSandboxSubmission,
  } from "../lib/html-sandbox";
  import { parseSandboxContentSize, sandboxFrameHeight } from "../lib/html-sandbox-layout";
  import { createSandboxRun } from "../lib/html-sandbox-run";

  let {
    source,
    onSubmit,
  }: {
    source: string;
    onSubmit: (payload: unknown) => Promise<"sent" | "queued">;
  } = $props();

  let frame = $state<HTMLIFrameElement | undefined>(undefined);
  let viewportSurface = $state<HTMLDivElement | undefined>(undefined);
  let viewportWidth = $state(0);
  let windowHeight = $state(typeof window !== "undefined" ? window.innerHeight : 800);
  let contentHeight = $state<number | undefined>();
  let running = $state(false);
  let loading = $state(false);
  const run = createSandboxRun();
  let frameGeneration = $state(0);
  let srcdoc = $state("");
  let expanded = $state(false);
  let showSource = $state(false);
  let status = $state("");
  let submitting = $state(false);
  let acceptedCount = 0;
  let lastSubmissionAt = 0;
  let mountedSource = $state<string | null>(null);
  let displayHeight = $derived(sandboxFrameHeight(contentHeight, expanded, windowHeight));

  // Sidebar, workbench and main-window resizing affect the iframe width even
  // without a window resize event. The browser fires the guest resize event.
  $effect(() => {
    const surface = viewportSurface;
    if (!surface || typeof ResizeObserver === "undefined") return;
    const update = () => { viewportWidth = Math.round(surface.clientWidth); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  });

  function sendScrollbarTheme(): void {
    if (!running || !frame?.contentWindow) return;
    const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim();
    frame.contentWindow.postMessage({ channel: HTML_SANDBOX_CHANNEL, type: "theme", muted }, "*");
  }

  $effect(() => {
    if (!running) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", sendScrollbarTheme);
    return () => query.removeEventListener("change", sendScrollbarTheme);
  });

  function stop(): void {
    run.cancel();
    loading = false;
    running = false;
    srcdoc = "";
    submitting = false;
    contentHeight = undefined;
  }

  async function start(): Promise<void> {
    stop();
    const requestedSource = source;
    loading = true;
    status = "Loading local prototype…";
    const prepared = await run.start(requestedSource);
    if (!prepared) return;
    if (source !== requestedSource) { stop(); return; }
    loading = false;
    if ("error" in prepared) { status = prepared.error; return; }
    srcdoc = prepared.srcdoc;
    acceptedCount = 0;
    lastSubmissionAt = 0;
    status = "";
    frameGeneration += 1;
    running = true;
    mountedSource = source;
  }

  // A rewritten assistant message invalidates its old executable document.
  $effect(() => {
    if (mountedSource === null) { mountedSource = source; return; }
    if (source !== mountedSource) {
      stop();
      mountedSource = source;
      status = "Prototype changed. Run it again to see the new version.";
    }
  });
  onDestroy(stop);

  async function handleMessage(event: MessageEvent): Promise<void> {
    // Opaque origin and exact WindowProxy identity are BOTH required. Never
    // accept a message from a different frame, session or external window.
    if (!running || !frame || event.source !== frame.contentWindow || event.origin !== "null") return;
    if (!event.data || event.data.channel !== HTML_SANDBOX_CHANNEL) return;
    if (event.data.type === "content-size") {
      const size = parseSandboxContentSize(event.data);
      if (size && size.height !== contentHeight) contentHeight = size.height;
      return;
    }
    if (submitting) return;
    let payload: unknown;
    try {
      payload = parseHtmlSandboxSubmission(event.data);
    } catch (error) {
      status = error instanceof Error ? error.message : "Invalid submission.";
      return;
    }
    if (acceptedCount >= 10) {
      status = "Submission limit reached. Restart the prototype to send more.";
      return;
    }
    const now = Date.now();
    if (now - lastSubmissionAt < 1_000) {
      status = "Please wait a second before submitting again.";
      return;
    }
    lastSubmissionAt = now;
    acceptedCount += 1;
    submitting = true;
    status = "Sending to agent…";
    const owner = frame.contentWindow;
    const ownerGeneration = frameGeneration;
    try {
      const result = await onSubmit(payload);
      // The user may have stopped or restarted the frame while ACP responded.
      if (!running || frameGeneration !== ownerGeneration || frame?.contentWindow !== owner) return;
      status = result === "queued" ? "Queued for the agent." : "Sent to the agent.";
      owner?.postMessage({ channel: HTML_SANDBOX_CHANNEL, type: "ack", status: result }, "*");
    } catch (error) {
      if (!running || frameGeneration !== ownerGeneration || frame?.contentWindow !== owner) return;
      status = error instanceof Error ? error.message : "The submission could not be sent.";
      owner?.postMessage({ channel: HTML_SANDBOX_CHANNEL, type: "ack", status: "error" }, "*");
    } finally {
      if (running && frameGeneration === ownerGeneration && frame?.contentWindow === owner) submitting = false;
    }
  }
</script>

<svelte:window onmessage={handleMessage} onresize={() => windowHeight = window.innerHeight} />

<section class="my-3 overflow-hidden rounded-md border border-border bg-panel" data-html-sandbox>
  <header class="flex min-h-9 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
    <div class="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
      <Code2 class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>HTML Sandbox</span>
      <span class="hidden text-muted-foreground sm:inline">· isolated JS · offline</span>
      {#if running && viewportWidth > 0}
        <span class="hidden font-mono font-normal text-muted-foreground sm:inline" aria-label="Sandbox viewport size">{viewportWidth} × {displayHeight}</span>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <button type="button" title={showSource ? "Hide source" : "Show source"} aria-label={showSource ? "Hide source" : "Show source"}
        class="grid h-7 w-7 place-items-center rounded-sm text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onclick={() => showSource = !showSource}><Code2 class="h-3.5 w-3.5" aria-hidden="true" /></button>
      <button type="button" title={expanded ? "Normal size" : "Enlarge"} aria-label={expanded ? "Normal size" : "Enlarge"}
        class="grid h-7 w-7 place-items-center rounded-sm text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onclick={() => expanded = !expanded}>
        {#if expanded}<Minimize2 class="h-3.5 w-3.5" aria-hidden="true" />{:else}<Maximize2 class="h-3.5 w-3.5" aria-hidden="true" />{/if}
      </button>
      <button type="button" title={running ? "Restart" : "Run"} aria-label={running ? "Restart prototype" : "Run prototype"}
        class="grid h-7 w-7 place-items-center rounded-sm text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring"
        onclick={start}>{#if running}<RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />{:else}<Play class="h-3.5 w-3.5" aria-hidden="true" />{/if}</button>
      {#if running || loading}
        <button type="button" title="Stop prototype" aria-label="Stop prototype"
          class="grid h-7 w-7 place-items-center rounded-sm text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onclick={() => { stop(); status = ""; }}><Square class="h-3 w-3" aria-hidden="true" /></button>
      {/if}
    </div>
  </header>

  <div bind:this={viewportSurface} class="relative w-full bg-white" style:height={`${displayHeight}px`}>
    {#if running}
      <!-- No allow-same-origin, popups, downloads, top navigation, or Pix IPC. -->
      {#key frameGeneration}
        <iframe bind:this={frame} title="Isolated HTML prototype" {srcdoc}
          sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"
          class="h-full w-full border-0" onload={sendScrollbarTheme}></iframe>
      {/key}
    {:else}
      <div class="grid h-full place-content-center gap-3 bg-panel-strong px-4 text-center">
        <p class="text-xs text-muted-foreground">This prototype contains executable JavaScript. It runs only when you choose Run.</p>
        <button type="button" onclick={start}
          class="mx-auto flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring">
          <Play class="h-3.5 w-3.5" aria-hidden="true" /> Run prototype
        </button>
      </div>
    {/if}
  </div>
  {#if showSource}
    <pre class="max-h-60 overflow-auto border-t border-border bg-code px-3 py-2 text-xs text-foreground"><code>{source}</code></pre>
  {/if}
  {#if status}
    <div role="status" class="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">{status}</div>
  {/if}
</section>
