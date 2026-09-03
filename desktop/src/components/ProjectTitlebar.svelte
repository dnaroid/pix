<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import { titlebarDrag } from "../lib/titlebar-drag";
  import { MAX_RECENT_PROJECTS, projectName } from "../lib/recent-projects";
  import ProjectFolderIcon from "./ProjectFolderIcon.svelte";

  let {
    workspace,
    recentProjects,
    open,
    disabled,
    onToggle,
    onSelectProject,
    onChooseWorkspace,
    onClose,
  }: {
    workspace: string;
    recentProjects: string[];
    open: boolean;
    disabled: boolean;
    onToggle: () => void;
    onSelectProject: (path: string) => void;
    onChooseWorkspace: () => void;
    onClose: () => void;
  } = $props();

  const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  let root = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);

  function handleWindowClick(event: MouseEvent): void {
    if (!open || !root || !(event.target instanceof Node) || root.contains(event.target)) return;
    onClose();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    onClose();
    trigger?.focus();
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (!open) onToggle();
    requestAnimationFrame(() => root?.querySelector<HTMLButtonElement>("[data-project-option]")?.focus());
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div
  class={[
    "relative flex min-w-0 shrink-0 items-center pr-1",
    isMacOS ? "pl-[76px]" : "pl-3",
  ]}
  data-tauri-drag-region
  bind:this={root}
>
  <button
    use:titlebarDrag
    bind:this={trigger}
    class="flex h-7 min-w-0 max-w-[220px] items-center gap-2 rounded-lg bg-transparent px-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    title={workspace || "Choose project"}
    aria-label={workspace ? `Change project, current project: ${projectName(workspace)}` : "Choose project"}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={onToggle}
    onkeydown={handleTriggerKeydown}
    {disabled}
  >
    <ProjectFolderIcon project={workspace || "workspace"} class="h-4 w-4 shrink-0" />
    <strong class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-foreground">
      {workspace ? projectName(workspace) : "Choose project"}
    </strong>
    <ChevronDown class={["h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180"]} aria-hidden="true" />
  </button>

  {#if open}
    <div
      class={[
        "absolute top-[calc(100%-1px)] z-30 grid max-h-[min(480px,calc(100vh-58px))] w-[min(360px,calc(100vw-24px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md",
        isMacOS ? "left-[76px]" : "left-3",
      ]}
      role="dialog"
      aria-label="Select project"
    >
      <div class="border-b border-border/60 px-3.5 py-2.5">
        <strong class="text-xs font-medium">Recent projects</strong>
        <span class="ml-1.5 text-[10px] text-muted-foreground">{recentProjects.length}/{MAX_RECENT_PROJECTS}</span>
      </div>

      <div class="min-h-0 overflow-y-auto px-1.5 py-1.5" aria-label="Recent projects">
        {#each recentProjects as project (project)}
          {@const selected = project === workspace}
          <button
            class={[
              "grid w-full grid-cols-[24px_minmax(0,1fr)_16px] items-center gap-2 rounded-md bg-transparent px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
              selected && "bg-accent",
            ]}
            data-project-option
            type="button"
            aria-current={selected ? "true" : undefined}
            onclick={() => onSelectProject(project)}
            {disabled}
          >
            <ProjectFolderIcon {project} class="h-[18px] w-[18px] justify-self-center" />
            <span class="min-w-0">
              <strong class="block overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium">
                {projectName(project)}
              </strong>
              <small class="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                {project}
              </small>
            </span>
            {#if selected}
              <Check class="h-4 w-4 text-primary" aria-hidden="true" />
            {:else}
              <span aria-hidden="true"></span>
            {/if}
          </button>
        {:else}
          <p class="mx-2.5 my-4 text-center text-xs text-muted-foreground">No recent projects</p>
        {/each}
      </div>

      <div class="border-t border-border/60 p-1.5">
        <button
          class="grid w-full grid-cols-[24px_minmax(0,1fr)] items-center gap-2 rounded-md bg-transparent px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          data-project-option
          type="button"
          onclick={onChooseWorkspace}
          {disabled}
        >
          <FolderPlus class="h-4 w-4 justify-self-center text-primary" aria-hidden="true" />
          <span class="min-w-0">
            <strong class="block text-xs font-medium">Choose or create project folder…</strong>
            <small class="mt-0.5 block text-[10px] text-muted-foreground">Open the system folder picker</small>
          </span>
        </button>
      </div>
    </div>
  {/if}
</div>
