<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import UserRound from "@lucide/svelte/icons/user-round";
  import { claudeAccountSwitcherConfig, selectClaudeAccountInSource, type ClaudeAccountSwitcherConfig } from "../lib/claude-account-switcher";
  import { parseSettingsSchema, settingsSourceIssues, type SettingsConfigDocument } from "../lib/settings";

  let { lastAttemptedAccount }: { lastAttemptedAccount?: string } = $props();

  let config = $state<ClaudeAccountSwitcherConfig>({ accounts: [], selectedAccount: "", autoRotate: false });
  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");
  let notice = $state("");
  let alive = false;
  let requestGeneration = 0;

  async function reload(): Promise<void> {
    const generation = ++requestGeneration;
    try {
      const current = await invoke<SettingsConfigDocument>("read_user_config", { kind: "pi-tools-suite" });
      const next = claudeAccountSwitcherConfig(current.content);
      if (!alive || generation !== requestGeneration || saving) return;
      config = next;
    } catch (caught) {
      if (alive && generation === requestGeneration) error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (alive && generation === requestGeneration) loading = false;
    }
  }

  onMount(() => {
    alive = true;
    void reload();
    // Settings can save the user-level Tools Suite config while this panel is open.
    const changed = () => { if (!saving) void reload(); };
    window.addEventListener("pix-semantic-config-changed", changed);
    return () => {
      alive = false;
      requestGeneration++;
      window.removeEventListener("pix-semantic-config-changed", changed);
    };
  });

  async function switchAccount(name: string): Promise<void> {
    if (saving || loading || (name === config.selectedAccount)) return;
    saving = true;
    error = "";
    notice = "";
    let reloadAfterConflict = false;
    try {
      // Always reread before editing. Another Settings editor may have saved
      // newer config since this popover opened.
      const current = await invoke<SettingsConfigDocument>("read_user_config", { kind: "pi-tools-suite" });
      if (!alive) return;
      const nextContent = selectClaudeAccountInSource(current.content, name);
      const issues = settingsSourceIssues(nextContent, parseSettingsSchema(current.schema));
      if (issues.length > 0) throw new Error(issues[0]);
      const result = await invoke<{ written: boolean; document: SettingsConfigDocument }>("write_user_config_if_unchanged", {
        kind: "pi-tools-suite",
        expectedContent: current.content,
        content: nextContent,
      });
      if (!result.written) {
        reloadAfterConflict = true;
        throw new Error("Tools Suite settings changed while switching. Try again.");
      }
      if (!alive) return;
      config = claudeAccountSwitcherConfig(result.document.content);
      notice = `Next Claude request: ${name || (config.autoRotate ? "automatic selection" : "default login")}. Existing quota figures may still belong to the prior profile.`;
      window.dispatchEvent(new CustomEvent("pix-semantic-config-changed"));
    } catch (caught) {
      if (alive) error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      saving = false;
      if (reloadAfterConflict && alive) void reload();
    }
  }
</script>

{#if config.accounts.length > 0}
{#if config.accounts.length > 0}
<div class="flex min-w-0 flex-1 flex-col items-end gap-0.5" data-claude-account-switcher>
  <label class="relative flex h-6 w-full max-w-36 min-w-0 items-center gap-1 rounded-md border border-border bg-panel-strong pl-1.5 pr-1.5 text-xs text-foreground hover:bg-panel-hover focus-within:outline-2 focus-within:outline-ring has-[:disabled]:opacity-60">
    <UserRound class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    <select
      class="h-full min-w-0 flex-1 appearance-none truncate bg-transparent pr-3 text-xs outline-none disabled:cursor-not-allowed"
      aria-label="Choose Claude Code OAuth account"
      value={config.selectedAccount}
      disabled={loading || saving}
      onchange={(event) => void switchAccount(event.currentTarget.value)}
    >
      <option value="">{config.autoRotate ? "Auto" : "Default"}</option>
      {#each config.accounts as account (account.name)}
        <option value={account.name}>{account.name}</option>
      {/each}
    </select>
    <ChevronDown class="pointer-events-none absolute right-1 h-3 w-3 text-muted-foreground" aria-hidden="true" />
  </label>
  {#if lastAttemptedAccount}
    <span class="max-w-36 truncate text-xs text-muted-foreground" aria-label={`Last attempted Claude account: ${lastAttemptedAccount}`}>Last: {lastAttemptedAccount}</span>
  {/if}
  {#if notice}
    <span class="max-w-36 truncate text-xs text-tool-warning" role="status" aria-live="polite">Saved · limits cached</span>
    <span class="sr-only">{notice}</span>
  {/if}
  {#if error}
    <span class="max-w-36 truncate text-xs text-tool-error" role="alert" aria-label={error}>Switch failed</span>
  {/if}
</div>
{/if}
{/if}
