<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import type { SessionInfo } from "@agentclientprotocol/sdk";

  let {
    sessions,
    activeSessionId,
    activeTitle,
    canCreate,
    disabled,
    onCreate,
    onSelect,
    onClose,
  }: {
    sessions: SessionInfo[];
    activeSessionId: string | null;
    activeTitle: string;
    canCreate: boolean;
    disabled: boolean;
    onCreate: () => void;
    onSelect: (sessionId: string) => void;
    onClose: (restoreFocus?: boolean) => void;
  } = $props();

  let query = $state("");
  let selector = $state<HTMLElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  const filteredSessions = $derived.by(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return sessions;
    return sessions.filter((session) => {
      const searchable = `${session.title ?? "Untitled conversation"} ${session.sessionId} ${displayDate(session.updatedAt)}`;
      return searchable.toLocaleLowerCase().includes(normalizedQuery);
    });
  });

  onMount(() => search?.focus());

  function handleWindowClick(event: MouseEvent): void {
    if (!selector || !(event.target instanceof Node) || selector.contains(event.target)) return;
    onClose();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose(true);
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selector?.querySelector<HTMLButtonElement>("[data-session-option]")?.focus();
      return;
    }
    if (event.key === "Enter" && filteredSessions[0]) {
      event.preventDefault();
      onSelect(filteredSessions[0].sessionId);
    }
  }

  function displayDate(value: string | null | undefined): string {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? ""
      : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div
  class="absolute top-[calc(100%-1px)] right-0 z-20 grid max-h-[min(480px,calc(100vh-82px))] w-[min(430px,calc(100vw-24px))] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
  role="dialog"
  aria-label="Select conversation"
  bind:this={selector}
>
  <div class="flex items-start justify-between gap-3 px-3.5 pt-3.5 pb-2.5">
    <div class="min-w-0">
      <span class="text-[10px] font-semibold tracking-[0.08em] text-primary uppercase">Current conversation</span>
      <strong class="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">{activeTitle}</strong>
    </div>
    <button
      class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      type="button"
      aria-label="Close session selector"
      onclick={() => onClose(true)}
    ><X class="h-4 w-4" aria-hidden="true" /></button>
  </div>

  <label class="px-3 pb-2.5">
    <span class="sr-only">Search conversations</span>
    <input
      class="h-[34px] w-full rounded-md border border-input bg-background px-2.5 text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
      bind:this={search}
      bind:value={query}
      type="search"
      placeholder="Search conversations…"
      onkeydown={handleSearchKeydown}
    />
  </label>

  <div class="min-h-0 overflow-y-auto border-t border-border/60 px-1.5 pt-1 pb-2" aria-label="Conversations">
    <button
      class="mb-1 grid w-full grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-t-md border-b border-border/60 bg-transparent px-2 py-2 text-left text-popover-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
      data-session-option
      type="button"
      onclick={onCreate}
      disabled={!canCreate}
    >
      <Plus class="h-4 w-4 justify-self-center text-primary" aria-hidden="true" />
      <span class="min-w-0">
        <strong class="block overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium">New conversation</strong>
        <small class="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted-foreground">Start a fresh session</small>
      </span>
    </button>

    {#each filteredSessions as session (session.sessionId)}
      <button
        class={[
          "grid w-full grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-md bg-transparent px-2 py-2 text-left text-popover-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
          session.sessionId === activeSessionId && "bg-accent",
        ]}
        data-session-option
        type="button"
        aria-current={session.sessionId === activeSessionId ? "true" : undefined}
        onclick={() => onSelect(session.sessionId)}
        {disabled}
      >
        {#if session.sessionId === activeSessionId}
          <Check class="h-4 w-4 text-primary" aria-hidden="true" />
        {:else}
          <span aria-hidden="true"></span>
        {/if}
        <span class="min-w-0">
          <strong class="block overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium">
            {session.title || "Untitled conversation"}
          </strong>
          <small class="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted-foreground">
            {displayDate(session.updatedAt) || session.sessionId.slice(0, 8)}
          </small>
        </span>
      </button>
    {:else}
      <p class="mx-2.5 my-4 text-center text-xs text-muted-foreground">No matching conversations</p>
    {/each}
  </div>
</div>
