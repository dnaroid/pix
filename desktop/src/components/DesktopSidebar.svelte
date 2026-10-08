<script lang="ts">
  import type { ComponentProps } from "svelte";
  import WorkspaceSidebar from "./WorkspaceSidebar.svelte";

  export type DesktopSidebarHandle = {
    revealProjectEntry: (path: string) => Promise<void>;
    openTasksPanel: (taskId?: string, isCurrent?: () => boolean) => Promise<void>;
    openSettingsSection: (id: string) => Promise<void>;
    openSettingsField: (section: string, fieldId: string) => Promise<void>;
    openGitPanel: (isCurrent?: () => boolean) => void;
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
