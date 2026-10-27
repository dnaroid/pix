<script lang="ts">
  import Blocks from "@lucide/svelte/icons/blocks";
  import ChartColumn from "@lucide/svelte/icons/chart-column";
  import Folder from "@lucide/svelte/icons/folder";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import SearchCheck from "@lucide/svelte/icons/search-check";
  import CodeXml from "@lucide/svelte/icons/code-xml";
  import Settings from "@lucide/svelte/icons/settings";
  import Play from "@lucide/svelte/icons/play";
  import ScrollText from "@lucide/svelte/icons/scroll-text";
  import { linearFocusIndex } from "../lib/keyboard-navigation";
  import type {
    SidebarIndicatorMap,
    SidebarIndicatorTab,
  } from "../lib/sidebar-indicators";
  import { sidebarIconTone } from "../lib/sidebar-icon-tone";

  type SidebarTab = SidebarIndicatorTab;

  const SIDEBAR_TABS: readonly SidebarTab[] = [
    "project",
    "tasks",
    "git",
    "registry",
    "scripts",
    "search",
    "usage",
    "lsp",
    "logs",
    "settings",
  ];

  let {
    indicators,
    activeTab,
    collapsed,
    logsEnabled = false,
    scriptsHaveActions = false,
    onSelect,
    onIndicatorContext,
  }: {
    indicators: SidebarIndicatorMap;
    activeTab: SidebarTab;
    collapsed: boolean;
    logsEnabled?: boolean;
    scriptsHaveActions?: boolean;
    onSelect: (tab: SidebarTab) => void;
    onIndicatorContext: (event: MouseEvent, tab: SidebarTab) => void;
  } = $props();

  let activityBar = $state<HTMLElement | null>(null);
  const visibleTabs = $derived(SIDEBAR_TABS.filter(tab => tab !== "logs" || logsEnabled));

  function selected(tab: SidebarTab): boolean {
    return activeTab === tab && !collapsed;
  }

  function activityTitle(tab: SidebarTab, label: string): string {
    const indicator = indicators[tab];
    return indicator ? `${label} — ${indicator.reason}` : label;
  }

  function activityLabel(tab: SidebarTab, label: string): string {
    const indicator = indicators[tab];
    return indicator ? `${label}, ${indicator.reason}` : label;
  }

  function handleKeydown(event: KeyboardEvent, tab: SidebarTab): void {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      event.stopPropagation();
      onIndicatorContext(new MouseEvent("contextmenu", { cancelable: true }), tab);
      return;
    }
    const currentIndex = visibleTabs.indexOf(tab);
    const nextIndex = linearFocusIndex(currentIndex, event.key, visibleTabs.length, "vertical", true);
    if (nextIndex === null) return;
    event.preventDefault();
    activityBar?.querySelectorAll<HTMLButtonElement>("[data-sidebar-tab]")[nextIndex]?.focus();
  }
</script>

<div
  bind:this={activityBar}
  class="flex h-full w-[30px] shrink-0 flex-col items-center border-r border-sidebar-border bg-[var(--workspace-chrome-background)] pt-1 pb-2"
  role="toolbar"
  aria-label="Workspace views"
  aria-orientation="vertical"
>
  <button
    class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("project") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "project" ? 0 : -1}
    title={activityTitle("project", activeTab === "project" && !collapsed ? "Hide Project" : "Project")}
    aria-label={activityLabel("project", "Project files")}
    aria-controls="workspace-project-panel"
    aria-pressed={activeTab === "project" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "project")}
    oncontextmenu={(event) => onIndicatorContext(event, "project")}
    aria-haspopup={indicators.project ? "menu" : undefined}
    onclick={() => onSelect("project")}
  >
    <Folder class={["h-5 w-5", sidebarIconTone(indicators.project)]} aria-hidden="true" />
  </button>
  <button
    class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("tasks") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "tasks" ? 0 : -1}
    title={activityTitle("tasks", activeTab === "tasks" && !collapsed ? "Hide Work" : "Work")}
    aria-label={activityLabel("tasks", "Work")}
    aria-controls="workspace-tasks-panel"
    aria-pressed={activeTab === "tasks" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "tasks")}
    oncontextmenu={(event) => onIndicatorContext(event, "tasks")}
    aria-haspopup={indicators.tasks ? "menu" : undefined}
    onclick={() => onSelect("tasks")}
  >
    <ListTodo class={["h-5 w-5", sidebarIconTone(indicators.tasks)]} aria-hidden="true" />
  </button>
  <button
    class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("git") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "git" ? 0 : -1}
    title={activityTitle("git", activeTab === "git" && !collapsed ? "Hide Source Control" : "Source Control")}
    aria-label={activityLabel("git", "Source Control")}
    aria-controls="workspace-git-panel"
    aria-pressed={activeTab === "git" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "git")}
    oncontextmenu={(event) => onIndicatorContext(event, "git")}
    aria-haspopup={indicators.git ? "menu" : undefined}
    onclick={() => onSelect("git")}
  >
    <GitBranch class={["h-5 w-5", sidebarIconTone(indicators.git)]} aria-hidden="true" />
  </button>
  <button
    class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("registry") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "registry" ? 0 : -1}
    title={activityTitle("registry", activeTab === "registry" && !collapsed ? "Hide Registry" : "Registry")}
    aria-label={activityLabel("registry", "Resource registry")}
    aria-controls="workspace-registry-panel"
    aria-pressed={activeTab === "registry" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "registry")}
    oncontextmenu={(event) => onIndicatorContext(event, "registry")}
    aria-haspopup={indicators.registry ? "menu" : undefined}
    onclick={() => onSelect("registry")}
  >
    <Blocks class={["h-5 w-5", sidebarIconTone(indicators.registry)]} aria-hidden="true" />
  </button>
  <button
    class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("scripts") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "scripts" ? 0 : -1}
    title={activityTitle("scripts", activeTab === "scripts" && !collapsed ? "Hide Launch Commands" : "Launch Commands")}
    aria-label={activityLabel("scripts", "Launch commands and terminals")}
    aria-controls="workspace-scripts-panel"
    aria-pressed={activeTab === "scripts" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "scripts")}
    oncontextmenu={(event) => onIndicatorContext(event, "scripts")}
    aria-haspopup={indicators.scripts || scriptsHaveActions ? "menu" : undefined}
    onclick={() => onSelect("scripts")}
  ><Play class={["h-5 w-5", sidebarIconTone(indicators.scripts)]} aria-hidden="true" /></button>
  <button
    class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("search") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "search" ? 0 : -1}
    title={activityTitle("search", activeTab === "search" && !collapsed ? "Hide search indexes" : "Search indexes")}
    aria-label={activityLabel("search", "Search index status")}
    aria-controls="workspace-search-index-panel"
    aria-pressed={activeTab === "search" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "search")}
    oncontextmenu={(event) => onIndicatorContext(event, "search")}
    aria-haspopup={indicators.search ? "menu" : undefined}
    onclick={() => onSelect("search")}
  >
    <SearchCheck class={["h-5 w-5", sidebarIconTone(indicators.search)]} aria-hidden="true" />
  </button>
  <button
    class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("usage") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button" data-sidebar-tab tabindex={activeTab === "usage" ? 0 : -1}
    title={activityTitle("usage", activeTab === "usage" && !collapsed ? "Hide Usage" : "Usage")}
    aria-label={activityLabel("usage", "Usage statistics")} aria-controls="workspace-usage-panel"
    aria-pressed={activeTab === "usage" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "usage")}
    oncontextmenu={(event) => onIndicatorContext(event, "usage")}
    onclick={() => onSelect("usage")}
  ><ChartColumn class={["h-5 w-5", sidebarIconTone(indicators.usage)]} aria-hidden="true" /></button>
  <button
    class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("lsp") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button" data-sidebar-tab tabindex={activeTab === "lsp" ? 0 : -1}
    title={activityTitle("lsp", activeTab === "lsp" && !collapsed ? "Hide Language Servers" : "Language Servers")}
    aria-label={activityLabel("lsp", "Language Servers")} aria-controls="workspace-lsp-panel"
    aria-pressed={activeTab === "lsp" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "lsp")}
    oncontextmenu={(event) => onIndicatorContext(event, "lsp")}
    onclick={() => onSelect("lsp")}
  ><CodeXml class={["h-5 w-5", sidebarIconTone(indicators.lsp)]} aria-hidden="true" /></button>
  {#if logsEnabled}
    <button
      class={["relative grid h-10 w-full place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("logs") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
      type="button" data-sidebar-tab tabindex={activeTab === "logs" ? 0 : -1}
      title={selected("logs") ? "Hide Logs" : "Logs"} aria-label="Logs" aria-controls="workspace-logs-panel" aria-pressed={selected("logs")}
      onkeydown={(event) => handleKeydown(event, "logs")} onclick={() => onSelect("logs")}
    ><ScrollText class="h-5 w-5" aria-hidden="true" /></button>
  {/if}
  <button
    class={["relative mt-auto grid h-10 w-full -translate-y-px place-items-center border-l-2 hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", selected("settings") ? "border-l-primary bg-background text-foreground" : "border-l-transparent text-muted-foreground"]}
    type="button"
    data-sidebar-tab
    tabindex={activeTab === "settings" ? 0 : -1}
    title={activityTitle("settings", activeTab === "settings" && !collapsed ? "Hide Settings" : "Settings")}
    aria-label={activityLabel("settings", "Settings")}
    aria-controls="workspace-settings-panel"
    aria-pressed={activeTab === "settings" && !collapsed}
    onkeydown={(event) => handleKeydown(event, "settings")}
    oncontextmenu={(event) => onIndicatorContext(event, "settings")}
    aria-haspopup={indicators.settings ? "menu" : undefined}
    onclick={() => onSelect("settings")}
  ><Settings class={["h-5 w-5", sidebarIconTone(indicators.settings)]} aria-hidden="true" /></button>
</div>
