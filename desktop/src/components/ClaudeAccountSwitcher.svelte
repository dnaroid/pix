<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  import UserRound from "@lucide/svelte/icons/user-round";
  import { claudeAccountSwitcherConfig, selectClaudeAccountInSource, type ClaudeAccountSwitcherConfig } from "../lib/claude-account-switcher";
  import { parseSettingsSchema, settingsSourceIssues, type SettingsConfigDocument } from "../lib/settings";
  import { toasts } from "../app/toasts.svelte";

  let { lastAttemptedAccount }: { lastAttemptedAccount?: string } = $props();

  let config = $state<ClaudeAccountSwitcherConfig>({ accounts: [], selectedAccount: "", autoRotate: false });
  let loading = $state(true);
  let saving = $state(false);
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
      if (alive && generation === requestGeneration) toasts.warning({ message: "Could not read Claude accounts.", detail: caught instanceof Error ? caught.message : String(caught), source: "Claude", key: "claude:account-read" });
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
      toasts.success({
        message: `Next Claude request: ${name || (config.autoRotate ? "automatic selection" : "default login")}.`,
        detail: "Existing quota figures may still belong to the prior profile.",
        source: "Claude", key: "claude:account-switch",
      });
      window.dispatchEvent(new CustomEvent("pix-semantic-config-changed"));
    } catch (caught) {
      if (alive) toasts.error({ message: "Could not switch Claude account.", detail: caught instanceof Error ? caught.message : String(caught), source: "Claude", key: "claude:account-switch" });
    } finally {
      saving = false;
      if (reloadAfterConflict && alive) void reload();
    }
  }
</script>

{#if config.accounts.length > 0}
<div class="flex min-w-0 flex-1 flex-col items-end gap-0.5" data-claude-account-switcher>
  <div class="w-full max-w-36 min-w-0">
    <TaskFieldSelect
      value={config.selectedAccount}
      options={[{ value: "", label: config.autoRotate ? "Auto" : "Default" }, ...config.accounts.map((account) => ({ value: account.name, label: account.name }))]}
      ariaLabel="Choose Claude Code OAuth account"
      size="xs"
      popupMinWidth={160}
      disabled={loading || saving}
      onChange={(value) => void switchAccount(value)}
    >
      {#snippet leading()}<UserRound class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />{/snippet}
    </TaskFieldSelect>
  </div>
  {#if lastAttemptedAccount}
    <span class="max-w-36 truncate text-xs text-muted-foreground" aria-label={`Last attempted Claude account: ${lastAttemptedAccount}`}>Last: {lastAttemptedAccount}</span>
  {/if}
</div>
{/if}
