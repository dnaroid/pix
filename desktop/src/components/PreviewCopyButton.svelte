<script lang="ts">
  import { isTauri } from "@tauri-apps/api/core";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import Files from "@lucide/svelte/icons/files";
  import { onDestroy } from "svelte";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import { iconButtonClass } from "../lib/icon-button";
  import { createPreviewCopyController } from "./preview-copy-controller";

  let { text, previewId, label = "Copy contents", disabled = false, fileCopy = false, onCopy }: {
    text: string;
    previewId: number;
    label?: string;
    disabled?: boolean;
    fileCopy?: boolean;
    onCopy?: (isCurrent: () => boolean) => Promise<void>;
  } = $props();
  const state = $state({ status: "", pending: false });
  const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));
  const controller = createPreviewCopyController(
    state,
    (content, isCurrent) => {
      if (onCopy) return onCopy(isCurrent);
      return isTauri() ? writeText(content) : navigator.clipboard.writeText(content);
    },
    (error) => diagnostics.report(error, "frontend:preview-copy"),
  );
  onDestroy(controller.dispose);

  $effect(() => {
    text;
    previewId;
    controller.reset();
  });
</script>

<button
  class={iconButtonClass("md", "popover")}
  type="button"
  aria-label={label}
  title={state.status || label}
  disabled={disabled || state.pending}
  onclick={() => void controller.copy(text)}
>
  {#if state.status === "Copied"}
    <Check class="h-4 w-4" aria-hidden="true" />
  {:else if fileCopy}
    <Files class="h-4 w-4" aria-hidden="true" />
  {:else}
    <Copy class="h-4 w-4" aria-hidden="true" />
  {/if}
</button>
<span class="sr-only" role="status">{state.status}</span>
