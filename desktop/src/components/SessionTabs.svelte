<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { tick } from "svelte";
  import type { SessionInfo } from "@agentclientprotocol/sdk";
  import {
    sessionActivityLabel,
    sessionActivityTone,
    type SessionActivitySummary,
  } from "../lib/session-activity";
  import { sessionTabFocusIndex } from "../lib/session-tabs";
  import { titlebarDrag } from "../lib/titlebar-drag";

  let {
    sessions,
    activeSessionId,
    runningSessionIds,
    activityBySessionId,
    needsInputSessionIds,
    disabled,
    canCreate,
    newSessionShortcut,
    onTabClick,
    onCloseTab,
    onCreate,
  }: {
    sessions: SessionInfo[];
    activeSessionId: string | null;
    runningSessionIds: ReadonlySet<string>;
    activityBySessionId: ReadonlyMap<string, SessionActivitySummary>;
    needsInputSessionIds: ReadonlySet<string>;
    disabled: boolean;
    canCreate: boolean;
    newSessionShortcut?: string;
    onTabClick: (sessionId: string) => void;
    onCloseTab: (sessionId: string) => boolean | Promise<boolean>;
    onCreate: () => void;
  } = $props();

  let tablist = $state<HTMLElement | null>(null);

  function sessionTitle(session: SessionInfo): string {
    const title = session.title || "Untitled conversation";
    if (!session.updatedAt) return title;
    const date = new Date(session.updatedAt);
    if (Number.isNaN(date.valueOf())) return title;
    return `${title} · ${date.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
  }

  function indicatorClass(tone: ReturnType<typeof sessionActivityTone>, active: boolean): string {
    if (tone === "warning") return "border-tool-warning bg-tool-warning opacity-100";
    if (tone === "info") return "border-tool-info bg-tool-info opacity-100";
    return active
      ? "border-primary bg-primary opacity-100"
      : "border-muted-foreground bg-transparent opacity-70";
  }

  function focusTab(index: number): void {
    tablist?.querySelectorAll<HTMLButtonElement>("[data-session-tab]")[index]?.focus();
    tablist?.querySelectorAll<HTMLButtonElement>("[data-session-tab]")[index]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }

  function handleTabKeydown(event: KeyboardEvent, index: number, sessionId: string): void {
    const nextIndex = sessionTabFocusIndex(index, event.key, sessions.length);
    if (nextIndex !== null) {
      event.preventDefault();
      focusTab(nextIndex);
      return;
    }
    if (event.key !== "Delete") return;
    if (disabled) return;
    event.preventDefault();
    const fallbackId = sessions[index + 1]?.sessionId ?? sessions[index - 1]?.sessionId;
    void Promise.resolve(onCloseTab(sessionId)).then(async (closed) => {
      if (!closed) return;
      await tick();
      if (fallbackId) {
        tablist?.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(fallbackId)}"]`)?.focus();
        return;
      }
      const selectedTab = tablist?.querySelector<HTMLButtonElement>("[data-session-tab][aria-selected='true']");
      if (selectedTab) {
        selectedTab.focus();
        return;
      }
      tablist?.parentElement?.querySelector<HTMLButtonElement>("[data-session-new]")?.focus();
    });
  }

  function handleTabMouseDown(event: MouseEvent, sessionId: string): void {
    if (event.button !== 1 || disabled) return;
    event.preventDefault();
    event.stopPropagation();
    void onCloseTab(sessionId);
  }

</script>

<nav
  class="flex min-w-0 flex-1 items-end overflow-hidden"
  aria-label="Saved conversations"
>
  <div class="flex min-w-0 max-w-full flex-[0_1_auto] items-end">
    <div
      bind:this={tablist}
      class="flex w-fit min-w-0 max-w-[calc(100%-32px)] items-end overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="Conversation tabs"
      aria-orientation="horizontal"
    >
      {#each sessions as session, index (session.sessionId)}
        {@const active = session.sessionId === activeSessionId}
        {@const running = runningSessionIds.has(session.sessionId)}
        {@const activity = activityBySessionId.get(session.sessionId)}
        {@const needsInput = needsInputSessionIds.has(session.sessionId)}
        {@const activityTone = sessionActivityTone(activity, running, needsInput)}
        {@const pulsing = running || (activity?.activeSubagents ?? 0) > 0}
        <div
          class={[
            "group relative -mb-px h-8 min-w-[120px] max-w-[240px] flex-[0_1_220px] overflow-hidden rounded-t-sm border transition-colors max-[760px]:basis-[200px]",
            active
              ? "border-border border-b-background bg-background"
              : "border-transparent hover:bg-chrome-hover",
          ]}
          role="presentation"
          onmousedown={(event) => handleTabMouseDown(event, session.sessionId)}
        >
          <button
            use:titlebarDrag
            class={[
              "flex h-full w-full items-center gap-2.5 bg-transparent pt-0 pr-9 pb-1.5 pl-3.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
              active && "font-medium text-foreground",
            ]}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls="conversation-workspace"
            tabindex={active || (!activeSessionId && index === 0) ? 0 : -1}
            data-session-tab
            data-session-id={session.sessionId}
            title={`${sessionTitle(session)} · ${sessionActivityLabel(activity, running, needsInput)}`}
            onclick={() => onTabClick(session.sessionId)}
            onkeydown={(event) => handleTabKeydown(event, index, session.sessionId)}
            {disabled}
          >
            <span
              class={[
                "h-[7px] w-[7px] shrink-0 rounded-full border opacity-70",
                indicatorClass(activityTone, active),
                pulsing && "animate-pulse motion-reduce:animate-none",
              ]}
              aria-hidden="true"
            ></span>
            <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {session.title || "Untitled conversation"}
            </span>
          </button>
          <button
            use:titlebarDrag
            class={[
              "absolute top-1/2 right-1.5 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md bg-transparent text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 group-hover:opacity-100 group-focus-within:opacity-100",
              active && "opacity-100",
            ]}
            type="button"
            tabindex="-1"
            aria-label={`Close ${session.title || "Untitled conversation"}`}
            title={running ? "Close tab and stop running session" : "Close tab"}
            onclick={() => void onCloseTab(session.sessionId)}
            disabled={disabled}
          ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>
      {/each}
    </div>

    <button
      use:titlebarDrag
      class="mb-0.5 grid h-7 w-6 shrink-0 place-items-center rounded-md bg-transparent text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
      title={newSessionShortcut ? `New conversation · ${newSessionShortcut}` : "New conversation"}
      aria-label="New conversation"
      data-session-new
      onclick={onCreate}
      disabled={!canCreate}
    ><Plus class="h-4 w-4" aria-hidden="true" /></button>
  </div>

  <div class="min-w-3 flex-1 self-stretch" data-tauri-drag-region></div>
</nav>
