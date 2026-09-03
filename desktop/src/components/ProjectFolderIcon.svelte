<script lang="ts">
  import { projectFolderHue } from "../lib/recent-projects";

  let {
    project,
    class: className = "h-4 w-4",
  }: {
    project: string;
    class?: string;
  } = $props();
</script>

<svg
  class={className}
  style:--project-folder-hue={projectFolderHue(project)}
  viewBox="0 0 20 20"
  fill="none"
  aria-hidden="true"
>
  <path
    d="M2.5 5.25A1.75 1.75 0 0 1 4.25 3.5h3.1c.46 0 .9.18 1.23.5l1.02 1h6.15a1.75 1.75 0 0 1 1.75 1.75v7.5A2.25 2.25 0 0 1 15.25 16.5H4.75a2.25 2.25 0 0 1-2.25-2.25v-9Z"
    fill="currentColor"
  />
</svg>

<style>
  svg {
    color: oklch(0.62 0.15 var(--project-folder-hue));
  }

  @media (prefers-color-scheme: dark) {
    svg {
      color: oklch(0.74 0.13 var(--project-folder-hue));
    }
  }
</style>
