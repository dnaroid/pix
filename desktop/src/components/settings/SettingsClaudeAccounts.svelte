<script lang="ts">
  import { isTauri } from "@tauri-apps/api/core";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Check from "@lucide/svelte/icons/check";
  import ClipboardCopy from "@lucide/svelte/icons/clipboard-copy";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { claudeAuthCommand, type ClaudeAccountSetting } from "../../lib/claude-account-settings";
  import SettingsTextInput from "./SettingsTextInput.svelte";

  let {
    value,
    onChange,
  }: {
    value: readonly ClaudeAccountSetting[];
    onChange: (next: ClaudeAccountSetting[]) => void;
  } = $props();

  let copied = $state("");

  function update(index: number, field: keyof ClaudeAccountSetting, raw: string): void {
    const rows = value.map((account) => ({ ...account }));
    rows[index]![field] = raw;
    onChange(rows);
  }

  function move(index: number, direction: -1 | 1): void {
    const next = index + direction;
    if (next < 0 || next >= value.length) return;
    const rows = [...value];
    [rows[index], rows[next]] = [rows[next]!, rows[index]!];
    onChange(rows);
  }

  async function copyCommand(index: number, command: "login" | "status"): Promise<void> {
    const account = value[index];
    if (!account?.configDir.trim()) return;
    try {
      const text = claudeAuthCommand(account.configDir, command);
      if (isTauri()) await writeText(text);
      else await navigator.clipboard.writeText(text);
      copied = `${index}:${command}`;
    } catch {
      copied = "failed";
    }
  }
</script>

<div class="space-y-2">
  {#if value.length === 0}
    <p class="text-xs text-muted-foreground">No OAuth profiles yet. Add a profile for each Claude subscription and sign in separately using the copied login command.</p>
  {/if}
  {#each value as account, index (index)}
    <div class="rounded-md border border-border bg-panel-strong p-2.5" data-claude-account={index}>
      <div class="flex items-center gap-1.5">
        <span class="min-w-0 flex-1 text-xs font-medium text-foreground">{index + 1}. {account.name.trim() || "Unnamed account"}</span>
        <button type="button" class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-30" aria-label={`Move account ${index + 1} up`} title="Try earlier" disabled={index === 0} onclick={() => move(index, -1)}><ArrowUp class="h-3.5 w-3.5" /></button>
        <button type="button" class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-30" aria-label={`Move account ${index + 1} down`} title="Try later" disabled={index === value.length - 1} onclick={() => move(index, 1)}><ArrowDown class="h-3.5 w-3.5" /></button>
        <button type="button" class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-tool-error focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Remove account ${index + 1}`} title="Remove profile from rotation (does not delete login data)" onclick={() => onChange(value.filter((_item, itemIndex) => itemIndex !== index))}><X class="h-3.5 w-3.5" /></button>
      </div>
      <div class="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label class="block min-w-0"><span class="mb-1 block text-[11px] text-muted-foreground">Label</span><SettingsTextInput value={account.name} placeholder="Personal" onChange={(next) => update(index, "name", next)} /></label>
        <label class="block min-w-0"><span class="mb-1 block text-[11px] text-muted-foreground">CLAUDE_CONFIG_DIR</span><SettingsTextInput value={account.configDir} placeholder="~/.claude-personal" onChange={(next) => update(index, "configDir", next)} /></label>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" class="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={!account.configDir.trim()} onclick={() => void copyCommand(index, "login")}><ClipboardCopy class="h-3 w-3" />{copied === `${index}:login` ? "Copied login" : "Copy login command"}</button>
        <button type="button" class="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={!account.configDir.trim()} onclick={() => void copyCommand(index, "status")}><Check class="h-3 w-3" />{copied === `${index}:status` ? "Copied status" : "Copy auth check"}</button>
        {#if copied === "failed"}<span role="status" class="text-xs text-tool-error">Clipboard unavailable</span>{/if}
      </div>
    </div>
  {/each}
  <button
    type="button"
    class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
    disabled={value.length >= 12}
    onclick={() => onChange([...value, { name: `Account ${value.length + 1}`, configDir: `~/.claude-account-${value.length + 1}` }])}
  ><Plus class="h-3.5 w-3.5" />Add OAuth profile</button>
  <p class="text-xs leading-4 text-muted-foreground">Only directory paths and labels are saved here. Claude Code owns the OAuth credentials; removing a row never logs out or deletes them. Save changes before sending the next request.</p>
</div>
