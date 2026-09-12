<script lang="ts">
  import Database from "@lucide/svelte/icons/database";
  import Folder from "@lucide/svelte/icons/folder";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import ScanSearch from "@lucide/svelte/icons/scan-search";
  import Settings from "@lucide/svelte/icons/settings";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import { linearFocusIndex } from "../lib/keyboard-navigation";
  import type {
    SidebarIndicatorMap,
    SidebarIndicatorTab,
  } from "../lib/sidebar-indicators";
  import ProjectFolderIcon from "./ProjectFolderIcon.svelte";
  import SidebarIndicatorDot from "./SidebarIndicatorDot.svelte";

  type SidebarTab = SidebarIndicatorTab;

  const SIDEBAR_TABS: readonly SidebarTab[] = [
    "project",
    "tasks",
    "git",
    "registry",
    "scripts",
    "idx",
    "settings",
  ];

  let {
    workspace,
    projectColors,
    indicators,
    activeTab,
    collapsed,
    onSelect,
  }: {
    workspace: string;
    projectColors: ReadonlyMap<string, string>;
    indicators: SidebarIndicatorMap;
    activeTab: SidebarTab;
    collapsed: boolean;
    onSelect: (tab: SidebarTab) => void;
  } = $props();

  let activityBar = $state<HTMLElement | null>(null);

  function activityTitle(tab: SidebarTab, label: string): string {
    const indicator = indicators[tab];
    return indicator ? `${label} — ${indicator.reason}` : label;
  }

  function activityLabel(tab: SidebarTab, label: string): string {
    const indicator = indicators[tab];
    return indicator ? `${label}, ${indicator.reason}` : label;
  }

  function handleKeydown(event: KeyboardEvent, tab: SidebarTab): void {
    const currentIndex = SIDEBAR_TABS.indexOf(tab);
    const nextIndex = linearFocusIndex(currentIndex, event.key, SIDEBAR_TABS.length, "vertical", true);
    if (nextIndex === null) return;
    event.preventDefault();
    activityBar?.querySelectorAll<HTMLButtonElement>("[data-sidebar-tab]")[nextIndex]?.focus();
  }
</script>

<div
  bind:this={activityBar}
  class="flex h-full w-10 shrink-0 flex-col items-center border-r border-sidebar-border bg-chrome py-1"
  role="toolbar"
  aria-label="Workspace views"
  aria-orientation="vertical"
>
  <button
    class={["relative grid h-10 w-10 place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "project" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "project" ? 0 : -1}
    title={activityTitle("project", activeTab === "project" && !collapsed ? "Hide Project" : "Project")}
    aria-label={activityLabel("project", "Project files")}
    aria-controls="workspace-project-panel"
    aria-pressed={activeTab === "project" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "project")}
    onclick={() => onSelect("project")}
  >
    {#if workspace}
      <ProjectFolderIcon project={workspace} color={projectColors.get(workspace)} class="h-5 w-5" />
    {:else}
      <Folder class="h-5 w-5" aria-hidden="true" />
    {/if}
    <SidebarIndicatorDot indicator={indicators.project} />
  </button>
  <button
    class={["relative grid h-10 w-10 place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "tasks" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "tasks" ? 0 : -1}
    title={activityTitle("tasks", activeTab === "tasks" && !collapsed ? "Hide Tasks" : "Tasks")}
    aria-label={activityLabel("tasks", "Tasks")}
    aria-controls="workspace-tasks-panel"
    aria-pressed={activeTab === "tasks" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "tasks")}
    onclick={() => onSelect("tasks")}
  >
    <ListTodo class="h-5 w-5" aria-hidden="true" />
    <SidebarIndicatorDot indicator={indicators.tasks} />
  </button>
  <button
    class={["relative grid h-10 w-10 place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "git" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "git" ? 0 : -1}
    title={activityTitle("git", activeTab === "git" && !collapsed ? "Hide Source Control" : "Source Control")}
    aria-label={activityLabel("git", "Source Control")}
    aria-controls="workspace-git-panel"
    aria-pressed={activeTab === "git" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "git")}
    onclick={() => onSelect("git")}
  >
    <GitBranch class="h-5 w-5" aria-hidden="true" />
    <SidebarIndicatorDot indicator={indicators.git} />
  </button>
  <button
    class={["relative grid h-10 w-10 place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "registry" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "registry" ? 0 : -1}
    title={activityTitle("registry", activeTab === "registry" && !collapsed ? "Hide Registry" : "Registry")}
    aria-label={activityLabel("registry", "Resource registry")}
    aria-controls="workspace-registry-panel"
    aria-pressed={activeTab === "registry" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "registry")}
    onclick={() => onSelect("registry")}
  >
    <Database class="h-5 w-5" aria-hidden="true" />
    <SidebarIndicatorDot indicator={indicators.registry} />
  </button>
  <button
    class={["relative grid h-10 w-10 place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "scripts" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "scripts" ? 0 : -1}
    title={activityTitle("scripts", activeTab === "scripts" && !collapsed ? "Hide Package Scripts" : "Package Scripts")}
    aria-label={activityLabel("scripts", "Package scripts and terminals")}
    aria-controls="workspace-scripts-panel"
    aria-pressed={activeTab === "scripts" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "scripts")}
    onclick={() => onSelect("scripts")}
  ><SquareTerminal class="h-5 w-5" aria-hidden="true" /><SidebarIndicatorDot indicator={indicators.scripts} /></button>
  <button
    class={["relative grid h-10 w-10 place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "idx" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "idx" ? 0 : -1}
    title={activityTitle("idx", activeTab === "idx" && !collapsed ? "Hide IDX" : "IDX")}
    aria-label={activityLabel("idx", "IDX repository intelligence")}
    aria-controls="workspace-idx-panel"
    aria-pressed={activeTab === "idx" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "idx")}
    onclick={() => onSelect("idx")}
  >
    <ScanSearch class="h-5 w-5" aria-hidden="true" />
    <SidebarIndicatorDot indicator={indicators.idx} />
  </button>
  <button
    class={["relative mt-auto grid h-10 w-10 place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "settings" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "settings" ? 0 : -1}
    title={activityTitle("settings", activeTab === "settings" && !collapsed ? "Hide Settings" : "Settings")}
    aria-label={activityLabel("settings", "Settings")}
    aria-controls="workspace-settings-panel"
    aria-pressed={activeTab === "settings" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "settings")}
    onclick={() => onSelect("settings")}
  ><Settings class="h-5 w-5" aria-hidden="true" /><SidebarIndicatorDot indicator={indicators.settings} /></button>
</div>
