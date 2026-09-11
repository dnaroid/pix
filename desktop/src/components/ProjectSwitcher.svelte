<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import { onMount } from "svelte";
  import { projectSwitcherMinimumWidth } from "../lib/project-switcher-layout";
  import { MAX_RECENT_PROJECTS, projectName, projectParentPath } from "../lib/recent-projects";
  import ProjectFolderIcon from "./ProjectFolderIcon.svelte";

  let {
    workspace,
    recentProjects,
    projectColors,
    currentWindowDisabled,
    onOpen,
    onMinimumWidthChange,
    onSelectProject,
    onOpenProjectInNewWindow,
    onChooseWorkspace,
    onChooseWorkspaceInNewWindow,
  }: {
    workspace: string;
    recentProjects: string[];
    projectColors: ReadonlyMap<string, string>;
    currentWindowDisabled: boolean;
    onOpen?: () => void;
    onMinimumWidthChange?: (width: number) => void;
    onSelectProject: (path: string) => void;
    onOpenProjectInNewWindow: (path: string) => void;
    onChooseWorkspace: () => void;
    onChooseWorkspaceInNewWindow: () => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let folderSlot = $state<HTMLSpanElement | null>(null);
  let textSlot = $state<HTMLSpanElement | null>(null);
  let chevronSlot = $state<HTMLSpanElement | null>(null);
  let open = $state(false);
  let reportedMinimumWidth = 0;

  $effect(() => {
    workspace;
    open = false;
    const frame = requestAnimationFrame(reportMinimumWidth);
    return () => cancelAnimationFrame(frame);
  });

  onMount(() => {
    reportMinimumWidth();
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(reportMinimumWidth);
    if (trigger) observer?.observe(trigger);
    if (folderSlot) observer?.observe(folderSlot);
    if (chevronSlot) observer?.observe(chevronSlot);
    void document.fonts?.ready.then(reportMinimumWidth);
    return () => observer?.disconnect();
  });

  function reportMinimumWidth(): void {
    if (!trigger || !folderSlot || !textSlot || !chevronSlot) return;
    const style = getComputedStyle(trigger);
    const name = textSlot.querySelector<HTMLElement>("strong");
    const width = projectSwitcherMinimumWidth({
      horizontalPadding: pixelValue(style.paddingLeft) + pixelValue(style.paddingRight),
      gap: pixelValue(style.columnGap || style.gap),
      fixedWidths: [
        folderSlot.getBoundingClientRect().width,
        chevronSlot.getBoundingClientRect().width,
      ],
      projectNameWidth: name?.scrollWidth ?? 0,
    });
    if (width === reportedMinimumWidth) return;
    reportedMinimumWidth = width;
    onMinimumWidthChange?.(width);
  }

  function pixelValue(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function toggle(): void {
    if (!open) onOpen?.();
    open = !open;
  }

  export function close(): void {
    open = false;
  }

  function selectProject(project: string): void {
    close();
    onSelectProject(project);
  }

  function chooseWorkspace(): void {
    close();
    onChooseWorkspace();
  }

  function chooseWorkspaceInNewWindow(): void {
    close();
    onChooseWorkspaceInNewWindow();
  }

  function handleWindowClick(event: MouseEvent): void {
    if (!open || !root || !(event.target instanceof Node) || root.contains(event.target)) return;
    close();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    close();
    trigger?.focus();
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (!open) toggle();
    requestAnimationFrame(() => root?.querySelector<HTMLButtonElement>("[data-project-option]")?.focus());
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div class="border-b border-sidebar-border bg-chrome/70" bind:this={root}>
  <button
    bind:this={trigger}
    class="group flex h-10 w-full min-w-0 items-center gap-2 px-2.5 text-left hover:bg-chrome-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    type="button"
    title={workspace || "Choose project"}
    aria-label={workspace ? `Change project, current project: ${projectName(workspace)}` : "Choose project"}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={toggle}
    onkeydown={handleTriggerKeydown}
  >
    <span bind:this={folderSlot} class="h-4 w-4 shrink-0" aria-hidden="true">
      <ProjectFolderIcon
        project={workspace || "workspace"}
        color={workspace ? projectColors.get(workspace) : undefined}
        class="h-full w-full"
      />
    </span>
    <span bind:this={textSlot} class="min-w-0 flex-1">
      <strong class="block truncate text-[11px] font-medium text-foreground">
        {workspace ? projectName(workspace) : "Open project"}
      </strong>
      {#if workspace}
        <small class="block truncate font-mono text-[10px] leading-3 text-muted-foreground">{projectParentPath(workspace)}</small>
      {/if}
    </span>
    <span bind:this={chevronSlot} class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-sidebar-border bg-background/55 text-muted-foreground transition-colors group-hover:border-border group-hover:text-foreground" aria-hidden="true">
      <ChevronDown class={["h-4 w-4 transition-transform", open && "rotate-180"]} />
    </span>
  </button>

  {#if open}
    <div class="grid max-h-[min(360px,46vh)] grid-rows-[auto_minmax(0,1fr)_auto] border-t border-sidebar-border bg-sidebar" role="dialog" aria-label="Select project">
      <div class="flex h-7 items-center px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        <span>Recent projects</span>
        <span class="ml-auto font-mono font-normal tracking-normal opacity-70">{recentProjects.length}/{MAX_RECENT_PROJECTS}</span>
      </div>

      <div class="min-h-0 overflow-y-auto px-1.5 pb-1.5">
        {#each recentProjects as project (project)}
          {@const selected = project === workspace}
          <div class={["group grid grid-cols-[minmax(0,1fr)_28px] rounded-md", selected && "bg-panel-selected"]}>
            <button
              class="grid min-w-0 grid-cols-[22px_minmax(0,1fr)_14px] items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
              data-project-option
              type="button"
              aria-current={selected ? "true" : undefined}
              onclick={() => selectProject(project)}
              disabled={currentWindowDisabled}
            >
              <ProjectFolderIcon project={project} color={projectColors.get(project)} class="h-4 w-4 justify-self-center" />
              <span class="min-w-0">
                <strong class="block truncate text-[11px] font-medium">{projectName(project)}</strong>
                <small class="block truncate font-mono text-[10px] leading-3 text-muted-foreground">{projectParentPath(project)}</small>
              </span>
              {#if selected}<Check class="h-3.5 w-3.5 text-primary" aria-hidden="true" />{/if}
            </button>
            <button
              class="m-0.5 grid place-items-center rounded-md text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
              data-project-option
              type="button"
              title={`Open ${projectName(project)} in a new window`}
              aria-label={`Open ${projectName(project)} in a new window`}
              onclick={() => onOpenProjectInNewWindow(project)}
            ><ExternalLink class="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
        {:else}
          <p class="px-2 py-4 text-center text-[11px] text-muted-foreground">No recent projects</p>
        {/each}
      </div>

      <div class="border-t border-sidebar-border p-1.5">
        <button
          class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          data-project-option
          type="button"
          onclick={chooseWorkspace}
          disabled={currentWindowDisabled}
        ><FolderPlus class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /><span class="truncate">Open folder…</span></button>
        <button
          class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          data-project-option
          type="button"
          onclick={chooseWorkspaceInNewWindow}
        ><ExternalLink class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /><span class="truncate">Open folder in new window…</span></button>
      </div>
    </div>
  {/if}
</div>
