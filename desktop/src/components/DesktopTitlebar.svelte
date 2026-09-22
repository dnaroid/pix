<script lang="ts">
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import type { ComponentProps } from "svelte";
  import SessionSelector from "./SessionSelector.svelte";
  import WorkbenchTabs from "./WorkbenchTabs.svelte";

  let {
    isMacOS,
    restartAvailable = false,
    restartPending = false,
    onRestart,
    project,
    workbench,
    selector,
  }: {
    isMacOS: boolean;
    restartAvailable?: boolean;
    restartPending?: boolean;
    onRestart?: () => void;
    project: {
      path: string;
      name: string;
      abbreviation: string;
      hue: number;
      color?: string;
    } | null;
    workbench: ComponentProps<typeof WorkbenchTabs>;
    selector: ComponentProps<typeof SessionSelector> | null;
  } = $props();
</script>

<header
  class="flex min-w-0 select-none items-stretch border-b border-border bg-window-titlebar text-chrome-foreground"
  data-tauri-drag-region
>
  <div class={["shrink-0", isMacOS ? "w-[76px]" : "w-3"]} data-tauri-drag-region></div>

  {#if project}
    <div class="flex shrink-0 items-center pr-1.5" data-tauri-drag-region>
      <span
        class="project-titlebar-badge grid h-6 w-6 cursor-default select-none place-items-center rounded-sm border border-border font-mono text-xs font-semibold"
        style:--project-titlebar-hue={project.hue}
        style:--project-titlebar-color={project.color}
        title={project.name}
        aria-label={"Project " + project.name}
        data-tauri-drag-region
        data-project-badge
      >{project.abbreviation}</span>
    </div>
  {/if}

  <div class="relative flex min-w-0 flex-1" data-tauri-drag-region>
    <WorkbenchTabs {...workbench} />

    {#if selector}
      <SessionSelector {...selector} />
    {/if}
  </div>

  {#if restartAvailable}
    <div class="flex shrink-0 items-center px-2">
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
    </div>
  {/if}
</header>

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
