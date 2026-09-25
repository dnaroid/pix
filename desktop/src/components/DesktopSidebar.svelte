<script lang="ts">
  import type { ComponentProps } from "svelte";
  import WorkspaceSidebar from "./WorkspaceSidebar.svelte";

  export type DesktopSidebarHandle = {
    openTasksPanel: (taskId?: string) => Promise<void>;
    closeProjectSwitcher: () => void;
  };

  let {
    props,
    instance = $bindable(null),
  }: {
    props: ComponentProps<typeof WorkspaceSidebar>;
    instance?: DesktopSidebarHandle | null;
  } = $props();
</script>

<WorkspaceSidebar bind:this={instance} {...props} />
