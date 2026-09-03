<script lang="ts">
  import { titlebarDrag } from "../lib/titlebar-drag";

  let {
    workspace,
    disabled,
    onChooseWorkspace,
  }: {
    workspace: string;
    disabled: boolean;
    onChooseWorkspace: () => void;
  } = $props();

  const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);

  function workspaceName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
  }
</script>

<div
  class={[
    "relative flex min-w-0 shrink-0 items-center pr-1",
    isMacOS ? "pl-[76px]" : "pl-3",
  ]}
  data-tauri-drag-region
>
  <button
    use:titlebarDrag
    class="flex h-7 min-w-0 max-w-[220px] items-center gap-2 rounded-lg bg-transparent px-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    title={workspace || "Choose workspace"}
    aria-label={workspace ? `Change workspace, current workspace: ${workspaceName(workspace)}` : "Choose workspace"}
    onclick={onChooseWorkspace}
    {disabled}
  >
    <span aria-hidden="true">▰</span>
    <strong class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-foreground">
      {workspace ? workspaceName(workspace) : "workspace"}
    </strong>
    <span class="shrink-0 text-[10px]" aria-hidden="true">⌄</span>
  </button>
</div>
