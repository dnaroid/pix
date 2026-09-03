<script lang="ts">
  import Folder from "@lucide/svelte/icons/folder";
  import { projectFolderHue } from "../lib/recent-projects";

  let {
    project,
    class: className = "h-4 w-4",
  }: {
    project: string;
    class?: string;
  } = $props();
</script>

<span
  class={className}
  style:--project-folder-hue={projectFolderHue(project)}
  aria-hidden="true"
>
  <Folder class="h-full w-full" aria-hidden="true" />
</span>

<style>
  span {
    color: oklch(0.62 0.15 var(--project-folder-hue));
  }

  @media (prefers-color-scheme: dark) {
    span {
      color: oklch(0.74 0.13 var(--project-folder-hue));
    }
  }
</style>
