<script lang="ts">
  import { iconButtonClass } from "../lib/icon-button";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Search from "@lucide/svelte/icons/search";
  import Clock from "@lucide/svelte/icons/clock";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import type { DesktopBuildStatus } from "../app/desktop-watch-restart.svelte";
  import type { ComponentProps } from "svelte";
  import ProjectSwitcher from "./ProjectSwitcher.svelte";
  import SessionSelector from "./SessionSelector.svelte";
  import WorkbenchTabs from "./WorkbenchTabs.svelte";

  let {
    isMacOS,
    restartAvailable = false,
    restartPending = false,
    buildStatus = "idle",
    onRestart,
    onSearch,
    projectSwitcher,
    workbench,
    selector,
  }: {
    isMacOS: boolean;
    restartAvailable?: boolean;
    restartPending?: boolean;
    buildStatus?: DesktopBuildStatus;
    onRestart?: () => void;
    onSearch?: () => void;
    projectSwitcher: Omit<ComponentProps<typeof ProjectSwitcher>, "variant"> | null;
    workbench: ComponentProps<typeof WorkbenchTabs>;
    selector: ComponentProps<typeof SessionSelector> | null;
  } = $props();

  const buildHints: Record<DesktopBuildStatus, string> = {
    idle: "",
    queued: "New build queued",
    building: "Building new version…",
    failed: "Build failed — see the pix-watch terminal for details",
  };
  const buildHint = $derived(buildHints[buildStatus]);
  const restartHint = $derived(restartPending ? "Restarting Desktop…" : "Restart Desktop to use the newly built version");
  const actionHint = $derived(restartPending ? restartHint : [buildHint, restartAvailable ? restartHint : ""].filter(Boolean).join(" — "));
</script>

<header
  class="flex min-w-0 select-none items-stretch border-b border-border bg-window-titlebar text-chrome-foreground"
  data-tauri-drag-region
>
  <div class={["shrink-0", isMacOS ? "w-[76px]" : "w-3"]} data-tauri-drag-region></div>

  {#if projectSwitcher?.workspace}
    <ProjectSwitcher {...projectSwitcher} variant="titlebar" />
  {/if}

  <div class="relative flex min-w-0 flex-1" data-tauri-drag-region>
    <WorkbenchTabs {...workbench} />

    {#if selector}
      <SessionSelector {...selector} />
    {/if}
  </div>

  {#if onSearch}
    <button type="button" onclick={onSearch} aria-label="Search current project" title="Search current project (⌘⇧F)"
      class={iconButtonClass("md", "chrome", { extra: "my-auto mr-2" })}>
      <Search class="h-4 w-4" aria-hidden="true" />
    </button>
  {/if}
  {#if restartAvailable || restartPending || buildStatus !== "idle"}
    <div class="flex shrink-0 items-center px-2" role="status" aria-label={actionHint}>
      <button
        type="button"
        class={iconButtonClass("sm", "chrome", { extra: [
          restartAvailable ? "bg-tool-error/10 text-tool-error enabled:hover:bg-tool-error/20" : "text-chrome-foreground disabled:opacity-100",
          buildStatus === "failed" ? "text-tool-error" : "",
          restartPending ? "disabled:cursor-wait disabled:opacity-60" : "",
        ].join(" ") })}
        title={actionHint}
        aria-label={actionHint}
        disabled={!restartAvailable || restartPending}
        onclick={onRestart}
      >
        {#if restartPending}
          <RotateCw class="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
        {:else if buildStatus === "building"}
          <LoaderCircle class="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
        {:else if buildStatus === "queued"}
          <Clock class="h-3.5 w-3.5" aria-hidden="true" />
        {:else if buildStatus === "failed"}
          <CircleAlert class="h-3.5 w-3.5" aria-hidden="true" />
        {:else}
          <RotateCw class="h-3.5 w-3.5" aria-hidden="true" />
        {/if}
      </button>
    </div>
  {/if}
</header>

<style>
  header { background-color: var(--workspace-chrome-background, var(--window-titlebar)); }
</style>
