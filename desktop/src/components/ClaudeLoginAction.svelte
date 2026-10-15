<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import LogIn from "@lucide/svelte/icons/log-in";
  import { onDestroy } from "svelte";
  import type { SettingsConfigDocument } from "../lib/settings";
  import { createClaudeLoginController } from "./claude-login-controller.svelte";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";

  let { onOpenTerminal, onError }: {
    onOpenTerminal: (command: string) => Promise<void>;
    onError: (error: unknown) => void;
  } = $props();
  const controller = createClaudeLoginController({
    readConfig: async () => (await invoke<SettingsConfigDocument>("read_user_config", { kind: "pi-tools-suite" })).content,
    openTerminal: (command) => onOpenTerminal(command),
    reportError: (error) => onError(error),
  });
  onDestroy(controller.dispose);
</script>

<div class="mt-2 flex flex-col items-start gap-2" data-claude-login-action>
  {#if controller.profiles}
    <div class="w-full max-w-64">
      <TaskFieldSelect
        value={controller.selected}
        options={[{ value: "", label: "Default Claude login" }, ...controller.profiles.accounts.map((account) => ({ value: account.name, label: account.name }))]}
        onChange={controller.select}
        ariaLabel="Claude account to sign in"
        disabled={controller.busy}
        compact
      />
    </div>
  {/if}
  <button type="button" class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-panel px-2 py-1 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50" disabled={controller.busy} onclick={() => void controller.login()}>
    <LogIn class="h-3.5 w-3.5" aria-hidden="true" />
    {controller.busy ? "Opening sign-in…" : "Sign in to Claude"}
  </button>
  <p class="text-muted-foreground">Complete sign-in in the terminal/browser, then return here and retry your request.</p>
  {#if controller.error}<p class="text-tool-error" role="alert">{controller.error}</p>{/if}
</div>
