<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";

  type ConnectionStatus = "starting" | "ready" | "error" | "stopped";
  type ConfigValue = { value: string; name: string; group?: string };

  let {
    status,
    configOptions,
    changingConfig,
    promptRunning,
    canRefresh,
    onSetConfig,
    onRefresh,
  }: {
    status: ConnectionStatus;
    configOptions: SessionConfigOption[];
    changingConfig: string | null;
    promptRunning: boolean;
    canRefresh: boolean;
    onSetConfig: (option: SessionConfigOption, value: string | boolean) => void;
    onRefresh: () => void;
  } = $props();

  function connectionLabel(value: ConnectionStatus): string {
    if (value === "ready") return "ACP";
    if (value === "starting") return "starting…";
    return value;
  }

  function configValues(option: SessionConfigOption): ConfigValue[] {
    if (option.type !== "select") return [];
    const values: ConfigValue[] = [];
    for (const entry of option.options) {
      if ("options" in entry) {
        values.push(...entry.options.map((item) => ({ ...item, group: entry.name })));
      } else {
        values.push({ value: entry.value, name: entry.name });
      }
    }
    return values;
  }

</script>

<footer class="flex min-w-0 items-center gap-3 border-t border-sidebar-border bg-sidebar px-[22px] text-[10px] text-muted-foreground max-[760px]:px-3">
  <div class={[
    "flex items-center gap-2",
    status === "error" && "text-destructive",
  ]}>
    <span class={[
      "h-1.5 w-1.5 rounded-full bg-status",
      status === "error" && "bg-destructive",
    ]}></span>
    <span class="max-[760px]:hidden">{connectionLabel(status)}</span>
  </div>

  <div class="flex min-w-0 items-center gap-3">
    {#each configOptions as option (option.id)}
      {#if option.type === "select"}
        <label class="flex min-w-0 items-center gap-1.5">
          <span class="text-muted-foreground/70 max-[760px]:hidden">{option.name}</span>
          <select
            class="h-6 max-w-[220px] appearance-none overflow-hidden rounded-sm border-0 bg-transparent py-0 pr-4 pl-0 text-primary transition-colors outline-none enabled:hover:bg-sidebar-accent enabled:hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
            aria-label={option.name}
            value={option.currentValue}
            disabled={changingConfig !== null || promptRunning}
            onchange={(event) => onSetConfig(option, event.currentTarget.value)}
          >
            {#each configValues(option) as value (value.value)}
              <option value={value.value}>{value.group ? `${value.group} · ` : ""}{value.name}</option>
            {/each}
          </select>
        </label>
      {:else}
        <label class="flex items-center gap-1.5">
          <input
            class="accent-primary transition-shadow enabled:hover:ring-2 enabled:hover:ring-ring/30 disabled:cursor-default disabled:opacity-40"
            type="checkbox"
            checked={option.currentValue}
            disabled={changingConfig !== null || promptRunning}
            onchange={(event) => onSetConfig(option, event.currentTarget.checked)}
          />
          <span>{option.name}</span>
        </label>
      {/if}
    {/each}
  </div>

  <span class="flex-1"></span>
  <button
    class="h-6 bg-transparent p-0 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    title="Refresh sessions"
    onclick={onRefresh}
    disabled={!canRefresh}
  ><RefreshCw class="h-3.5 w-3.5" aria-hidden="true" /></button>
</footer>
