<script lang="ts">
  import type { SessionInfo } from "@agentclientprotocol/sdk";
  import { titlebarDrag } from "../lib/titlebar-drag";

  let {
    sessions,
    allSessionsCount,
    activeSessionId,
    selectorOpen,
    disabled,
    canCreate,
    onTabClick,
    onPickerClick,
    onCloseTab,
    onCreate,
  }: {
    sessions: SessionInfo[];
    allSessionsCount: number;
    activeSessionId: string | null;
    selectorOpen: boolean;
    disabled: boolean;
    canCreate: boolean;
    onTabClick: (event: MouseEvent, sessionId: string) => void;
    onPickerClick: (event: MouseEvent) => void;
    onCloseTab: (event: MouseEvent, sessionId: string) => void;
    onCreate: () => void;
  } = $props();

  function sessionTitle(session: SessionInfo): string {
    const title = session.title || "Untitled conversation";
    if (!session.updatedAt) return title;
    const date = new Date(session.updatedAt);
    if (Number.isNaN(date.valueOf())) return title;
    return `${title} · ${date.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
  }

</script>

<nav
  class="flex min-w-0 flex-1 items-end overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
  aria-label="Saved conversations"
  data-tauri-drag-region
>
  {#each sessions as session (session.sessionId)}
    {@const active = session.sessionId === activeSessionId}
    <div
      class={[
        "group relative -mb-px h-8 min-w-[140px] max-w-[280px] flex-[0_1_280px] overflow-hidden rounded-t-lg border transition-colors max-[760px]:basis-[230px]",
        active
          ? "border-border border-b-background bg-background"
          : "border-transparent hover:bg-sidebar-accent",
      ]}
    >
      <button
        use:titlebarDrag
        class={[
          "flex h-full w-full items-center gap-2.5 bg-transparent pt-0 pr-9 pb-1.5 pl-3.5 text-left text-muted-foreground transition-colors hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
          active && "font-medium text-foreground",
        ]}
        aria-current={active ? "page" : undefined}
        aria-haspopup={active ? "dialog" : undefined}
        aria-expanded={active ? selectorOpen : undefined}
        title={sessionTitle(session)}
        onclick={(event) => onTabClick(event, session.sessionId)}
        {disabled}
      >
        <span
          class={[
            "h-[7px] w-[7px] shrink-0 rounded-full border opacity-70",
            active ? "border-primary bg-primary opacity-100" : "border-muted-foreground",
          ]}
          aria-hidden="true"
        ></span>
        <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {session.title || "Untitled conversation"}
        </span>
        {#if active}<span class="ml-0.5 shrink-0 text-xs text-muted-foreground" aria-hidden="true">⌄</span>{/if}
      </button>
      <button
        use:titlebarDrag
        class={[
          "absolute top-1/2 right-1.5 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md bg-transparent pb-0.5 text-base leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 group-hover:opacity-100 group-focus-within:opacity-100",
          active && "opacity-100",
        ]}
        type="button"
        aria-label={`Close ${session.title || "Untitled conversation"}`}
        title="Close tab"
        onclick={(event) => onCloseTab(event, session.sessionId)}
        {disabled}
      >×</button>
    </div>
  {/each}

  {#if sessions.length === 0 && allSessionsCount > 0}
    <div class="group relative -mb-px h-8 min-w-[140px] max-w-[280px] flex-[0_1_280px] overflow-hidden rounded-t-lg border border-transparent transition-colors hover:bg-sidebar-accent max-[760px]:basis-[230px]">
      <button
        use:titlebarDrag
        class="flex h-full w-full items-center gap-2.5 bg-transparent pt-0 px-3.5 pb-1.5 text-left text-muted-foreground transition-colors hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        aria-haspopup="dialog"
        aria-expanded={selectorOpen}
        title="Open a saved conversation"
        onclick={onPickerClick}
        {disabled}
      >
        <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">Open conversation</span>
        <span class="shrink-0 text-xs text-muted-foreground" aria-hidden="true">⌄</span>
      </button>
    </div>
  {/if}

  <button
    use:titlebarDrag
    class="mx-1.5 mb-0.5 grid h-7 min-w-7 shrink-0 place-items-center rounded-lg bg-transparent pb-0.5 text-[17px] leading-none text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    title="New conversation"
    aria-label="New conversation"
    onclick={onCreate}
    disabled={!canCreate}
  >+</button>
</nav>
