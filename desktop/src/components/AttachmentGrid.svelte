<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import File from "@lucide/svelte/icons/file";
  import Play from "@lucide/svelte/icons/play";
  import X from "@lucide/svelte/icons/x";
  import type { Attachment } from "../lib/attachments";

  let {
    attachments,
    variant = "chat",
    onOpen,
    onRemove,
  }: {
    attachments: readonly Attachment[];
    variant?: "composer" | "chat" | "tool";
    onOpen: (attachment: Attachment) => void;
    onRemove?: (id: string) => void;
  } = $props();

  let failedPreviews = $state(new Set<string>());

  function previewUrl(attachment: Attachment): string | undefined {
    if (attachment.dataUrl) return attachment.dataUrl;
    return attachment.path ? convertFileSrc(attachment.path) : undefined;
  }

  function markPreviewFailed(id: string): void {
    failedPreviews = new Set([...failedPreviews, id]);
  }
</script>

{#if attachments.length > 0}
  <div class={[
    "flex flex-wrap gap-2",
    variant === "chat" && "mb-2.5 justify-start",
    variant === "tool" && "mt-2",
    variant === "composer" && "mb-2",
  ]}>
    {#each attachments as attachment (attachment.id)}
      <div class={[
        "group/attachment relative",
        variant === "chat" && attachment.kind === "image" && "max-w-full",
      ]}>
        <button
          class={[
            "relative grid overflow-hidden rounded-lg border border-border bg-muted text-left text-muted-foreground transition-colors hover:border-input hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            variant === "composer"
              ? "h-16 w-20"
              : variant === "chat" && attachment.kind === "image"
                ? "w-fit max-w-full"
                : "h-28 w-40",
            attachment.kind === "file" && "place-items-center px-2 py-2",
          ]}
          type="button"
          title={attachment.kind === "file" ? `Open ${attachment.name}` : `Preview ${attachment.name}`}
          aria-label={attachment.kind === "file" ? `Open ${attachment.name}` : `Preview ${attachment.name}`}
          onclick={() => onOpen(attachment)}
        >
          {#if attachment.kind === "image" && previewUrl(attachment) && !failedPreviews.has(attachment.id)}
            <img
              class={variant === "chat"
                ? "block h-auto max-h-80 w-auto max-w-full object-contain"
                : "h-full w-full object-cover"}
              src={previewUrl(attachment)}
              alt=""
              onerror={() => markPreviewFailed(attachment.id)}
            />
          {:else if attachment.kind === "video" && previewUrl(attachment) && !failedPreviews.has(attachment.id)}
            <video class="h-full w-full object-cover" src={previewUrl(attachment)} muted preload="metadata" playsinline onerror={() => markPreviewFailed(attachment.id)}></video>
            <span class="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden="true">
              <span class="grid h-7 w-7 place-items-center rounded-full bg-background/80 text-foreground shadow-xs">
                <Play class="h-3.5 w-3.5 fill-current" />
              </span>
            </span>
          {:else}
            <File class="h-5 w-5" aria-hidden="true" />
            <span class="line-clamp-2 max-w-full text-center text-[10px] leading-tight break-all">{attachment.name}</span>
          {/if}
        </button>
        {#if onRemove}
          <button
            class="absolute -top-1.5 -right-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-popover text-popover-foreground opacity-0 shadow-xs transition hover:bg-accent hover:text-accent-foreground group-hover/attachment:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            type="button"
            aria-label={`Remove ${attachment.name}`}
            title={`Remove ${attachment.name}`}
            onclick={() => onRemove?.(attachment.id)}
          >
            <X class="h-3 w-3" aria-hidden="true" />
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}
