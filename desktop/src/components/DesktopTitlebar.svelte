<script lang="ts">
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Clock from "@lucide/svelte/icons/clock";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import type { DesktopBuildStatus } from "../app/desktop-watch-restart.svelte";
  import type { ComponentProps } from "svelte";
  import { projectFolderHue } from "../lib/recent-projects";
  import ProjectSwitcher from "./ProjectSwitcher.svelte";
  import SessionSelector from "./SessionSelector.svelte";
  import WorkbenchTabs from "./WorkbenchTabs.svelte";

  let {
    isMacOS,
    restartAvailable = false,
    restartPending = false,
    buildStatus = "idle",
    onRestart,
    projectSwitcher,
    workbench,
    selector,
  }: {
    isMacOS: boolean;
    restartAvailable?: boolean;
    restartPending?: boolean;
    buildStatus?: DesktopBuildStatus;
    onRestart?: () => void;
    projectSwitcher: Omit<ComponentProps<typeof ProjectSwitcher>, "variant"> | null;
    workbench: ComponentProps<typeof WorkbenchTabs>;
    selector: ComponentProps<typeof SessionSelector> | null;
  } = $props();

  const projectWorkspace = $derived(projectSwitcher?.workspace ?? "");
  const buildHints: Record<DesktopBuildStatus, string> = {
    idle: "",
    queued: "New build queued",
    building: "Building new version…",
    failed: "Build failed — see the pix-watch terminal for details",
  };
  const buildHint = $derived(buildHints[buildStatus]);
  const projectTitlebarColor = $derived(
    projectWorkspace ? projectSwitcher?.projectColors.get(projectWorkspace) : undefined,
  );
  const projectTitlebarHue = $derived(
    projectWorkspace ? projectFolderHue(projectWorkspace) : undefined,
  );
</script>

<header
  class={[
    "flex min-w-0 select-none items-stretch border-b border-border bg-window-titlebar text-chrome-foreground",
    projectWorkspace && "project-window-titlebar",
  ]}
  style:--project-window-titlebar-color={projectTitlebarColor}
  style:--project-window-titlebar-hue={projectTitlebarHue}
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

  {#if restartAvailable || buildStatus !== "idle"}
    <div class="flex shrink-0 items-center gap-1 px-2">
      {#if buildStatus !== "idle"}
        <span
          class={["grid h-7 w-7 place-items-center", buildStatus === "failed" ? "text-tool-error" : "text-chrome-foreground"]}
          role="status"
          aria-label={buildHint}
          title={buildHint}
        >
          {#if buildStatus === "queued"}
            <Clock class="h-4 w-4" aria-hidden="true" />
          {:else if buildStatus === "building"}
            <LoaderCircle class="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
          {:else}
            <CircleAlert class="h-4 w-4" aria-hidden="true" />
          {/if}
        </span>
      {/if}
      {#if restartAvailable}
      <button
        type="button"
        class="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60"
        title={restartPending ? "Restarting Desktop…" : "Restart Desktop to use the newly built version"}
        aria-label={restartPending ? "Restarting Desktop" : "Restart Desktop to use the newly built version"}
        disabled={restartPending}
        onclick={onRestart}
      >
        <RotateCw class={["h-4 w-4", restartPending ? "animate-spin" : ""]} aria-hidden="true" />
      </button>
      {/if}
    </div>
  {/if}
</header>

<style>
  .project-window-titlebar {
    background-color: color-mix(
      in srgb,
      var(
          --project-window-titlebar-color,
          oklch(0.62 0.15 var(--project-window-titlebar-hue))
        )
        8%,
      var(--window-titlebar)
    );
  }

  @media (prefers-color-scheme: dark) {
    .project-window-titlebar {
      background-color: color-mix(
        in srgb,
        var(
            --project-window-titlebar-color,
            oklch(0.74 0.13 var(--project-window-titlebar-hue))
          )
          8%,
        var(--window-titlebar)
      );
    }
  }
</style>
