<script lang="ts">
  import { activityIcon } from "../lib/tool-icons";
  import type { ToolCallStatus } from "@agentclientprotocol/sdk";
  import type { ToolAttention } from "../lib/tool-output";

  let {
    status,
    label,
    attention,
    imageRead = false,
    class: className = "h-3 w-3",
  }: {
    status: ToolCallStatus;
    label: string;
    attention?: ToolAttention;
    imageRead?: boolean;
    class?: string;
  } = $props();

  const Icon = $derived(activityIcon(label, imageRead));
  const statusColor = $derived.by(() => {
    if (status === "failed") return "text-tool-error";
    if (status === "in_progress") return "text-primary";
    if (status === "completed") {
      if (attention === "error") return "text-tool-error";
      if (attention === "warning") return "text-tool-warning";
      return "text-tool-success";
    }
    return "text-muted-foreground";
  });
  const statusLabel = $derived(status === "completed" && attention ? attention : status);
</script>

<span class="inline-flex shrink-0" role="img" aria-label={`${label}: ${statusLabel}`} title={`${label}: ${statusLabel}`}>
  <Icon class={`${className} ${statusColor}`} aria-hidden="true" />
</span>
