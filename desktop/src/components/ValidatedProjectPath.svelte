<script lang="ts">
  import type { ProjectPathKind, ProjectPathNavigation } from "../lib/project-path-navigation";
  import { createValidatedProjectPath } from "../lib/validated-project-path";

  let { path, kind, navigation, onNavigate }: {
    path: string;
    kind: ProjectPathKind;
    navigation?: ProjectPathNavigation;
    onNavigate: () => void;
  } = $props();
  let valid = $state(true);
  let controller: ReturnType<typeof createValidatedProjectPath> | undefined;
  $effect(() => {
    valid = true;
    controller = navigation ? createValidatedProjectPath(path, kind, navigation, (exists) => { valid = exists; }, onNavigate) : undefined;
    const current = controller;
    return () => current?.dispose();
  });
</script>

{#if navigation && valid}
  <button type="button" class="break-all text-left text-tool-search underline decoration-transparent underline-offset-2 hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring" onclick={() => void controller?.open()}>{path}</button>
{:else}
  <span class="break-all">{path}</span>
{/if}
