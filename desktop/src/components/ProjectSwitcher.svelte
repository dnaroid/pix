<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import { onDestroy, onMount } from "svelte";
  import {
    isTypeaheadKey,
    menuFocusIndex,
    menuTypeaheadFocusIndex,
    type MenuNavigationItem,
  } from "../lib/keyboard-navigation";
  import { projectSwitcherMinimumWidth } from "../lib/project-switcher-layout";
  import {
    MAX_RECENT_PROJECTS,
    projectAbbreviation,
    projectFolderHue,
    projectName,
    projectParentPath,
  } from "../lib/recent-projects";
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
    variant = "sidebar",
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
    variant?: "sidebar" | "titlebar";
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let textSlot = $state<HTMLSpanElement | null>(null);
  let chevronSlot = $state<HTMLSpanElement | null>(null);
  let open = $state(false);
  let reportedMinimumWidth = 0;
  let menu = $state<HTMLDivElement | null>(null);
  let menuTypeaheadQuery = "";
  let menuTypeaheadTimer: number | null = null;
  let observedWorkspace: string | undefined;

  onDestroy(() => {
    if (menuTypeaheadTimer !== null) window.clearTimeout(menuTypeaheadTimer);
  });

  $effect(() => {
    const nextWorkspace = workspace;
    if (observedWorkspace === undefined) {
      observedWorkspace = nextWorkspace;
    } else if (nextWorkspace !== observedWorkspace) {
      observedWorkspace = nextWorkspace;
      open = false;
    }
    const frame = requestAnimationFrame(reportMinimumWidth);
    return () => cancelAnimationFrame(frame);
  });

  onMount(() => {
    reportMinimumWidth();
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(reportMinimumWidth);
    if (trigger) observer?.observe(trigger);
    if (chevronSlot) observer?.observe(chevronSlot);
    void document.fonts?.ready.then(reportMinimumWidth);
    return () => observer?.disconnect();
  });

  function reportMinimumWidth(): void {
    if (!trigger || !textSlot || !chevronSlot) return;
    const style = getComputedStyle(trigger);
    const name = textSlot.querySelector<HTMLElement>("strong");
    const width = projectSwitcherMinimumWidth({
      horizontalPadding: pixelValue(style.paddingLeft) + pixelValue(style.paddingRight),
      gap: pixelValue(style.columnGap || style.gap),
      fixedWidths: [chevronSlot.getBoundingClientRect().width],
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

  function openProjectInNewWindow(project: string): void {
    close();
    onOpenProjectInNewWindow(project);
  }

  function handleWindowClick(event: MouseEvent): void {
    if (!open || !root || !(event.target instanceof Node) || root.contains(event.target)) return;
    close();
  }

  function handleWindowFocusin(event: FocusEvent): void {
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
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!open) toggle();
    requestAnimationFrame(() => {
      const items = projectMenuNavigationItems();
      const index = menuFocusIndex(items, -1, event.key);
      if (index !== null) projectMenuButtons()[index]?.focus();
    });
  }

  function projectMenuButtons(): HTMLButtonElement[] {
    return [...(menu?.querySelectorAll<HTMLButtonElement>("[data-project-option]") ?? [])];
  }

  function projectMenuNavigationItems(): MenuNavigationItem[] {
    return projectMenuButtons().map((button) => ({
      label: button.getAttribute("aria-label") ?? button.textContent ?? "",
      disabled: button.disabled,
    }));
  }

  function handleMenuKeydown(event: KeyboardEvent): void {
    const buttons = projectMenuButtons();
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-project-option]")
      : null;
    const currentIndex = target ? buttons.indexOf(target) : -1;
    const items = projectMenuNavigationItems();

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger?.focus();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    const nextIndex = menuFocusIndex(items, currentIndex, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      buttons[nextIndex]?.focus();
      return;
    }
    if (!isTypeaheadKey(event)) return;
    event.preventDefault();
    const key = event.key.toLocaleLowerCase();
    let query = menuTypeaheadQuery.length === 1 && menuTypeaheadQuery === key
      ? key
      : `${menuTypeaheadQuery}${key}`;
    let typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    if (typeaheadIndex === null && query.length > 1) {
      query = key;
      typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    }
    menuTypeaheadQuery = query;
    if (menuTypeaheadTimer !== null) window.clearTimeout(menuTypeaheadTimer);
    menuTypeaheadTimer = window.setTimeout(() => {
      menuTypeaheadQuery = "";
      menuTypeaheadTimer = null;
    }, 700);
    if (typeaheadIndex !== null) buttons[typeaheadIndex]?.focus();
  }
</script>

<svelte:window onclick={handleWindowClick} onfocusin={handleWindowFocusin} onkeydown={handleWindowKeydown} />

<div
  class={variant === "titlebar"
    ? "relative flex h-full shrink-0 items-center pr-1.5"
    : "border-b border-sidebar-border bg-chrome/70"}
  bind:this={root}
>
  {#if variant === "titlebar"}
    <button
      bind:this={trigger}
      class="project-titlebar-badge grid h-6 w-6 select-none place-items-center rounded-sm border border-border font-mono text-xs font-semibold hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring"
      style:--project-titlebar-hue={projectFolderHue(workspace)}
      style:--project-titlebar-color={projectColors.get(workspace)}
      type="button"
      title={projectName(workspace)}
      aria-label={`Change project, current project: ${projectName(workspace)}`}
      aria-haspopup="menu"
      aria-expanded={open}
      data-project-badge
      onclick={toggle}
      onkeydown={handleTriggerKeydown}
    >{projectAbbreviation(workspace)}</button>
  {:else}
    <button
      bind:this={trigger}
      class="group flex h-10 w-full min-w-0 items-center gap-2 px-2.5 text-left hover:bg-chrome-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      type="button"
      title={workspace || "Choose project"}
      aria-label={workspace ? `Change project, current project: ${projectName(workspace)}` : "Choose project"}
      aria-haspopup="menu"
      aria-expanded={open}
      onclick={toggle}
      onkeydown={handleTriggerKeydown}
    >
      <span bind:this={textSlot} class="min-w-0 flex-1">
        <strong class="block truncate text-xs font-medium text-foreground">
          {workspace ? projectName(workspace) : "Open project"}
        </strong>
        {#if workspace}
          <small class="block truncate font-mono text-xs leading-4 text-muted-foreground">{projectParentPath(workspace)}</small>
        {/if}
      </span>
      <span bind:this={chevronSlot} class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-sidebar-border bg-background/55 text-muted-foreground transition-colors group-hover:border-border group-hover:text-foreground" aria-hidden="true">
        <ChevronDown class={["h-4 w-4 transition-transform", open && "rotate-180"]} />
      </span>
    </button>
  {/if}

  {#if open}
    <div
      bind:this={menu}
      class={[
        "grid max-h-[min(360px,46vh)] grid-rows-[auto_minmax(0,1fr)_auto] bg-sidebar",
        variant === "titlebar"
          ? "absolute left-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-sidebar-border shadow-xl"
          : "border-t border-sidebar-border",
      ]}
      role="menu"
      tabindex="-1"
      aria-label="Select project"
      onkeydown={handleMenuKeydown}
    >
      <div class="flex h-7 items-center px-2.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
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
              role="menuitem"
              tabindex="-1"
              aria-current={selected ? "true" : undefined}
              onclick={() => selectProject(project)}
              disabled={currentWindowDisabled}
            >
              <ProjectFolderIcon project={project} color={projectColors.get(project)} class="h-4 w-4 justify-self-center" />
              <span class="min-w-0">
                <strong class="block truncate text-xs font-medium">{projectName(project)}</strong>
                <small class="block truncate font-mono text-xs leading-4 text-muted-foreground">{projectParentPath(project)}</small>
              </span>
              {#if selected}<Check class="h-3.5 w-3.5 text-primary" aria-hidden="true" />{/if}
            </button>
            <button
              class="m-0.5 grid place-items-center rounded-md text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
              data-project-option
              type="button"
              role="menuitem"
              tabindex="-1"
              title={`Open ${projectName(project)} in a new window`}
              aria-label={`Open ${projectName(project)} in a new window`}
              onclick={() => openProjectInNewWindow(project)}
            ><ExternalLink class="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
        {:else}
          <p class="px-2 py-4 text-center text-xs text-muted-foreground">No recent projects</p>
        {/each}
      </div>

      <div class="border-t border-sidebar-border p-1.5">
        <button
          class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          data-project-option
          type="button"
          role="menuitem"
          tabindex="-1"
          onclick={chooseWorkspace}
          disabled={currentWindowDisabled}
        ><FolderPlus class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /><span class="truncate">Open folder…</span></button>
        <button
          class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          data-project-option
          type="button"
          role="menuitem"
          tabindex="-1"
          onclick={chooseWorkspaceInNewWindow}
        ><ExternalLink class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /><span class="truncate">Open folder in new window…</span></button>
      </div>
    </div>
  {/if}
</div>

<style>
  .project-titlebar-badge {
    background-color: var(--project-titlebar-color, oklch(0.62 0.15 var(--project-titlebar-hue)));
    color: var(--primary-foreground);
  }

  @media (prefers-color-scheme: dark) {
    .project-titlebar-badge {
      background-color: var(--project-titlebar-color, oklch(0.74 0.13 var(--project-titlebar-hue)));
    }
  }
</style>
