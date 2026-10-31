<script lang="ts">
  import { untrack } from "svelte";
  import Bold from "@lucide/svelte/icons/bold";
  import Italic from "@lucide/svelte/icons/italic";
  import Heading1 from "@lucide/svelte/icons/heading-1";
  import Heading2 from "@lucide/svelte/icons/heading-2";
  import Heading3 from "@lucide/svelte/icons/heading-3";
  import Pilcrow from "@lucide/svelte/icons/pilcrow";
  import List from "@lucide/svelte/icons/list";
  import ListOrdered from "@lucide/svelte/icons/list-ordered";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Link from "@lucide/svelte/icons/link";
  import Image from "@lucide/svelte/icons/image";
  import Table from "@lucide/svelte/icons/table";
  import Code from "@lucide/svelte/icons/code";
  import SquareCode from "@lucide/svelte/icons/square-code";
  import Quote from "@lucide/svelte/icons/quote";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import Redo2 from "@lucide/svelte/icons/redo-2";
  import X from "@lucide/svelte/icons/x";
  import { iconButtonClass } from "../lib/icon-button";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import { isSafeWikiUrl } from "../lib/wiki-markdown-content";
  import {
    createWikiMarkdownEditor, emptyWikiEditorSelection,
    type WikiEditorAction, type WikiMarkdownEditor,
  } from "../lib/wiki-markdown-editor";

  interface Props {
    value: string;
    documentPath: string;
    workspace?: string;
    disabled?: boolean;
    onChange: (markdown: string) => void;
    onSave: () => void;
    onResolveImage?: (source: string) => Promise<string | undefined>;
    onOpenLink?: (href: string) => void | Promise<void>;
    onSourceRequested?: () => void;
  }
  let {
    value, documentPath, workspace = "", disabled = false, onChange, onSave,
    onResolveImage, onOpenLink, onSourceRequested,
  }: Props = $props();
  let host = $state<HTMLDivElement>();
  let runtime = $state.raw<WikiMarkdownEditor | null>(null);
  let loading = $state(true);
  let failure = $state<string | null>(null);
  let selection = $state({ ...emptyWikiEditorSelection });
  let insertion = $state<"link" | "image" | null>(null);
  let address = $state("");
  let label = $state("");
  let formError = $state("");
  const diagnostic = createDiagnosticLogger(() => ({ workspace }));
  const inactive = $derived(disabled || loading || Boolean(failure));
  const tools = [
    { action: "paragraph", title: "Paragraph", icon: Pilcrow },
    { action: "heading1", title: "Heading 1", icon: Heading1 },
    { action: "heading2", title: "Heading 2", icon: Heading2 },
    { action: "heading3", title: "Heading 3", icon: Heading3 },
    { action: "bold", title: "Bold (⌘B)", icon: Bold },
    { action: "italic", title: "Italic (⌘I)", icon: Italic },
    { action: "bulletList", title: "Bullet list", icon: List },
    { action: "orderedList", title: "Numbered list", icon: ListOrdered },
    { action: "taskList", title: "Task list", icon: ListTodo },
    { action: "quote", title: "Quote", icon: Quote },
    { action: "inlineCode", title: "Inline code", icon: Code },
    { action: "codeBlock", title: "Code block", icon: SquareCode },
    { action: "table", title: "Insert table", icon: Table },
  ] satisfies { action: WikiEditorAction; title: string; icon: typeof Bold }[];

  function fail(error: unknown) {
    diagnostic.warn("wiki:editor-failed", error);
    failure = error instanceof Error ? error.message : "The visual editor could not open this document.";
    loading = false;
  }

  $effect(() => {
    const element = host;
    const path = documentPath;
    const project = workspace;
    if (!element) return;
    // A pending editor owns its own mount, so stale setup/teardown cannot remove
    // the replacement document when tabs or projects change during creation.
    const mount = document.createElement("div");
    mount.className = "wiki-editor-mount";
    element.replaceChildren(mount);
    const initial = untrack(() => value);
    let owner: WikiMarkdownEditor | null = null;
    let disposed = false;
    loading = true;
    failure = null;
    runtime = null;
    insertion = null;
    selection = { ...emptyWikiEditorSelection };
    void createWikiMarkdownEditor({
      element: mount, value: initial,
      disabled: () => disabled,
      onChange: (markdown) => { if (!disposed) onChange(markdown); },
      onSave: () => { if (!disposed) onSave(); },
      onSelectionChange: (next) => { if (!disposed) selection = next; },
      onError: (error) => { if (!disposed) diagnostic.warn("wiki:editor-error", error); },
      onResolveImage: (source) => disposed ? Promise.resolve(undefined)
        : onResolveImage ? onResolveImage(source) : Promise.resolve(source),
      onOpenLink: (href) => { if (!disposed) return onOpenLink?.(href); },
    }).then(async (created) => {
      if (disposed) { await created.destroy(); return; }
      owner = created;
      runtime = created;
      if (value !== initial) created.setValue(value);
      created.setDisabled();
      loading = false;
    }).catch((error) => { if (!disposed) fail(error); else diagnostic.warn("wiki:editor-dispose", error); });
    // The path is the editor owner; delayed creation from the old tab cannot win.
    void path;
    void project;
    return () => {
      disposed = true;
      mount.remove();
      if (owner) void owner.destroy().catch((error) => diagnostic.warn("wiki:editor-dispose", error));
    };
  });

  $effect(() => {
    const editor = runtime;
    const next = value;
    if (!editor) return;
    try { editor.setValue(next); }
    catch (error) { fail(error); }
  });

  $effect(() => {
    void disabled;
    runtime?.setDisabled();
  });

  export function readMarkdown(): string { return failure ? value : runtime?.readMarkdown() ?? value; }
  export function focus(): void { runtime?.focus(); }
  function action(command: WikiEditorAction) {
    if (inactive) return;
    try { runtime?.action(command); }
    catch (error) { diagnostic.warn("wiki:editor-command", error); }
  }
  function active(command: WikiEditorAction): boolean {
    return command === "bold" ? selection.bold : command === "italic" ? selection.italic
      : command.startsWith("heading") ? selection.heading === Number(command.at(-1)) : false;
  }
  function preserveSelection(event: PointerEvent) { event.preventDefault(); }
  function openInsertion(kind: "link" | "image") {
    insertion = kind;
    address = kind === "link" ? selection.href : "";
    label = selection.text;
    formError = "";
  }
  function closeInsertion() { insertion = null; runtime?.focus(); }
  function insertReference(event: SubmitEvent) {
    event.preventDefault();
    if (inactive) return;
    const source = address.trim();
    if (!isSafeWikiUrl(source, insertion === "image")) {
      formError = "Enter a relative file path or an http(s) URL.";
      return;
    }
    try {
      if (insertion === "image") runtime?.insertImage(source, label);
      else runtime?.insertLink(source, label);
      insertion = null;
    } catch (error) {
      diagnostic.warn("wiki:editor-insert", error);
      formError = "Could not insert this reference.";
    }
  }
  function focusField(element: HTMLInputElement) { element.focus(); }
  function toolbarNavigation(element: HTMLElement) {
    let current: HTMLButtonElement | undefined;
    const all = () => [...element.querySelectorAll<HTMLButtonElement>("button")];
    const enabled = () => all().filter((button) => !button.disabled);
    function refresh() {
      const available = enabled();
      if (!current || !available.includes(current)) current = available[0];
      for (const button of all()) button.tabIndex = button === current ? 0 : -1;
    }
    function focus(event: FocusEvent) {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button instanceof HTMLButtonElement && element.contains(button) && !button.disabled) {
        current = button;
        refresh();
      }
    }
    function keydown(event: KeyboardEvent) {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      const available = enabled();
      if (!available.length) return;
      const index = available.indexOf(current ?? available[0]!);
      const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1
        : event.key === "ArrowRight" ? (index + 1) % available.length
          : event.key === "ArrowLeft" ? (index + available.length - 1) % available.length : undefined;
      if (next == null) return;
      event.preventDefault();
      current = available[next];
      refresh();
      current?.focus();
    }
    const observer = new MutationObserver(refresh);
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    element.addEventListener("focusin", focus);
    element.addEventListener("keydown", keydown);
    refresh();
    return { destroy() {
      observer.disconnect();
      element.removeEventListener("focusin", focus);
      element.removeEventListener("keydown", keydown);
    } };
  }
</script>

<div class="wiki-markdown-editor flex h-full min-h-0 flex-col bg-panel text-foreground">
  <div use:toolbarNavigation class="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border bg-panel px-2 py-1" role="toolbar" aria-label="Markdown formatting" aria-orientation="horizontal">
    {#each tools as tool}
      <button type="button" class={iconButtonClass("md", "panel", { extra: active(tool.action) ? "bg-panel-selected text-foreground" : "" })}
        title={tool.title} aria-label={tool.title} aria-pressed={active(tool.action)} disabled={inactive}
        onpointerdown={preserveSelection} onclick={() => action(tool.action)}>
        <tool.icon size={15} strokeWidth={1.75} />
      </button>
    {/each}
    <span class="mx-1 h-4 border-l border-border" aria-hidden="true"></span>
    <button type="button" class={iconButtonClass("md", "panel")} title="Insert link" aria-label="Insert link"
      disabled={inactive} onpointerdown={preserveSelection} onclick={() => openInsertion("link")}><Link size={15} strokeWidth={1.75} /></button>
    <button type="button" class={iconButtonClass("md", "panel")} title="Insert image" aria-label="Insert image"
      disabled={inactive} onpointerdown={preserveSelection} onclick={() => openInsertion("image")}><Image size={15} strokeWidth={1.75} /></button>
    <span class="flex-1"></span>
    <button type="button" class={iconButtonClass("md", "panel")} title="Undo (⌘Z)" aria-label="Undo"
      disabled={inactive || !selection.canUndo} onpointerdown={preserveSelection} onclick={() => action("undo")}><Undo2 size={15} strokeWidth={1.75} /></button>
    <button type="button" class={iconButtonClass("md", "panel")} title="Redo (⇧⌘Z)" aria-label="Redo"
      disabled={inactive || !selection.canRedo} onpointerdown={preserveSelection} onclick={() => action("redo")}><Redo2 size={15} strokeWidth={1.75} /></button>
  </div>
  {#if selection.inTable && !failure}
    <div use:toolbarNavigation class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1 text-xs" role="toolbar" aria-label="Table editing" aria-orientation="horizontal">
      {#each [
        { action: "addRow", label: "Add row" }, { action: "addColumn", label: "Add column" },
        { action: "deleteRow", label: "Delete row" }, { action: "deleteColumn", label: "Delete column" },
        { action: "deleteTable", label: "Delete table" },
      ] as item}
        <button type="button" class="h-6 px-2 text-muted-foreground hover:bg-panel-hover hover:text-foreground disabled:opacity-50"
          disabled={inactive} onpointerdown={preserveSelection} onclick={() => action(item.action as WikiEditorAction)}>{item.label}</button>
      {/each}
    </div>
  {/if}
  {#if insertion}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions Escape dismisses this inline form and restores editor focus. -->
    <form class="flex shrink-0 flex-wrap items-end gap-2 border-b border-border bg-panel-strong p-3" onsubmit={insertReference}
      onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeInsertion(); } }}>
      <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        {insertion === "image" ? "Image path or URL" : "Link path or URL"}
        <input use:focusField bind:value={address} class="h-8 border border-input bg-background px-2 text-sm text-foreground outline-none"
          placeholder={insertion === "image" ? "images/map.png" : "combat.md#damage"} disabled={inactive} />
      </label>
      <label class="flex min-w-32 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        {insertion === "image" ? "Description" : "Link text"}
        <input bind:value={label} class="h-8 border border-input bg-background px-2 text-sm text-foreground outline-none"
          placeholder={insertion === "image" ? "Map of the world" : "Combat rules"} disabled={inactive} />
      </label>
      <button type="submit" class="h-8 border border-border bg-panel px-3 text-xs hover:bg-panel-hover disabled:opacity-50" disabled={inactive}>Insert</button>
      <button type="button" class={iconButtonClass("md", "panel")} aria-label="Cancel insertion" title="Cancel" onclick={closeInsertion}><X size={15} /></button>
      {#if formError}<p class="w-full text-xs text-muted-foreground" role="alert">{formError}</p>{/if}
    </form>
  {/if}
  {#if loading}<p class="p-4 text-sm text-muted-foreground" role="status">Opening editor…</p>{/if}
  {#if failure}
    <div class="p-4 text-sm" role="alert">
      <p>{failure}</p>
      {#if onSourceRequested}<button type="button" class="mt-3 h-8 border border-border bg-panel px-3 text-xs hover:bg-panel-hover" onclick={onSourceRequested}>Edit Markdown source</button>{/if}
    </div>
  {/if}
  <div bind:this={host} class="wiki-editor-host min-h-0 flex-1 overflow-auto" class:invisible={loading} hidden={Boolean(failure)}></div>
</div>

<style>
  .wiki-editor-host :global(.milkdown) { min-height: 100%; }
  .wiki-editor-host :global(.wiki-editor-mount) { min-height: 100%; }
  .wiki-editor-host :global(.wiki-prose-editor) {
    box-sizing: border-box; min-height: 100%; max-width: 880px; margin: 0 auto;
    padding: 24px 32px 96px; outline: none; white-space: pre-wrap; overflow-wrap: anywhere;
    font-family: var(--font-sans); font-size: 14px; line-height: 1.7; color: var(--foreground);
  }
  .wiki-editor-host :global(.ProseMirror[contenteditable="false"]) { opacity: 0.7; }
  .wiki-editor-host :global(p) { margin: 0.6em 0; }
  .wiki-editor-host :global(h1), .wiki-editor-host :global(h2), .wiki-editor-host :global(h3),
  .wiki-editor-host :global(h4), .wiki-editor-host :global(h5), .wiki-editor-host :global(h6) {
    font-weight: 600; line-height: 1.3; margin: 1.4em 0 0.55em;
  }
  .wiki-editor-host :global(h1) { font-size: 1.8em; }
  .wiki-editor-host :global(h2) { font-size: 1.4em; }
  .wiki-editor-host :global(h3) { font-size: 1.15em; }
  .wiki-editor-host :global(ul), .wiki-editor-host :global(ol) { padding-left: 1.6em; margin: 0.6em 0; }
  .wiki-editor-host :global(ul) { list-style-type: disc; }
  .wiki-editor-host :global(ol) { list-style-type: decimal; }
  .wiki-editor-host :global(li > .wiki-list-content > p) { margin: 0.15em 0; }
  .wiki-editor-host :global(li.wiki-task-item) { list-style: none; position: relative; }
  .wiki-editor-host :global(.wiki-task-item > input) { position: absolute; left: -1.5em; top: 0.45em; margin: 0; accent-color: var(--primary); }
  .wiki-editor-host :global(.wiki-task-item[data-checked="true"] > .wiki-list-content > p) { color: var(--muted-foreground); }
  .wiki-editor-host :global(blockquote) { border-left: 2px solid var(--border); margin: 1em 0; padding-left: 1em; color: var(--muted-foreground); }
  .wiki-editor-host :global(a) { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
  .wiki-editor-host :global(code), .wiki-editor-host :global(pre) { font-family: var(--font-mono); font-size: 0.92em; }
  .wiki-editor-host :global(code) { background: var(--panel-strong); padding: 0.1em 0.25em; }
  .wiki-editor-host :global(pre) { background: var(--panel-strong); padding: 1em; overflow-x: auto; white-space: pre; }
  .wiki-editor-host :global(pre code) { background: none; padding: 0; }
  .wiki-editor-host :global(hr) { border: 0; border-top: 1px solid var(--border); margin: 1.5em 0; }
  .wiki-editor-host :global(table) { table-layout: fixed; width: 100%; border-collapse: collapse; margin: 1em 0; }
  .wiki-editor-host :global(th), .wiki-editor-host :global(td) { position: relative; min-width: 64px; border: 1px solid var(--border); padding: 6px 10px; vertical-align: top; }
  .wiki-editor-host :global(th) { background: var(--panel-strong); font-weight: 600; }
  .wiki-editor-host :global(.selectedCell::after) { content: ""; position: absolute; inset: 0; background: var(--panel-selected); opacity: 0.5; pointer-events: none; }
  .wiki-editor-host :global(.column-resize-handle) { position: absolute; top: 0; right: -2px; bottom: 0; width: 4px; background: var(--primary); pointer-events: none; }
  .wiki-editor-host :global(.resize-cursor) { cursor: col-resize; }
  .wiki-editor-host :global(img) { max-width: 100%; height: auto; }
  .wiki-editor-host :global(.wiki-inline-image) { display: inline-block; max-width: 100%; vertical-align: middle; }
  .wiki-editor-host :global(.wiki-image-fallback) { display: inline-block; border: 1px solid var(--border); padding: 8px 12px; font-size: 12px; color: var(--muted-foreground); }
  .wiki-editor-host :global([hidden]) { display: none; }
  .wiki-editor-host :global(.ProseMirror-selectednode) { outline: 2px solid var(--ring); }
  @media (max-width: 640px) { .wiki-editor-host :global(.wiki-prose-editor) { padding: 16px 20px 64px; } }
</style>
