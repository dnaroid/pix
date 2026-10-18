<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import LogIn from "@lucide/svelte/icons/log-in";
  import Play from "@lucide/svelte/icons/play";
  import { onDestroy } from "svelte";
  import type { SettingsConfigDocument } from "../lib/settings";
  import { createClaudeLoginController } from "./claude-login-controller.svelte";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";

  let { onOpenTerminal, onError, onContinue }: {
    onOpenTerminal: (command: string) => Promise<void>;
    onError: (error: unknown) => void;
    /** Resumes the interrupted run after the user finished signing in. */
    onContinue?: () => Promise<unknown>;
  } = $props();
  const controller = createClaudeLoginController({
    readConfig: async () => (await invoke<SettingsConfigDocument>("read_user_config", { kind: "pi-tools-suite" })).content,
    openTerminal: (command) => onOpenTerminal(command),
    reportError: (error) => onError(error),
  });
  let continuing = $state(false);
  let continued = $state(false);
  let continueError = $state("");
  let disposed = false;
  onDestroy(() => { disposed = true; controller.dispose(); });

  async function resume(): Promise<void> {
    if (!onContinue || continuing || continued) return;
    continuing = true;
    continueError = "";
    try {
      await onContinue();
      if (!disposed) continued = true;
    } catch (error) {
      if (!disposed) {
        continueError = error instanceof Error ? error.message : "Could not continue the conversation.";
        onError(error);
      }
    } finally {
      if (!disposed) continuing = false;
    }
  }

  const buttonClass = "inline-flex items-center gap-1.5 rounded-sm border border-border bg-panel px-2 py-1 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
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
  <div class="flex flex-wrap items-center gap-2">
    <button type="button" class={buttonClass} disabled={controller.busy} onclick={() => void controller.login()}>
      <LogIn class="h-3.5 w-3.5" aria-hidden="true" />
      {controller.busy ? "Opening sign-in…" : "Sign in to Claude"}
    </button>
    {#if onContinue}
      <button type="button" class={buttonClass} disabled={continuing || continued} onclick={() => void resume()} data-claude-login-continue>
        <Play class="h-3.5 w-3.5" aria-hidden="true" />
        {continuing ? "Continuing…" : continued ? "Continued" : "Continue"}
      </button>
    {/if}
  </div>
  <p class="text-muted-foreground">
    {onContinue
      ? "Complete sign-in in the terminal/browser, then press Continue to resume."
      : "Complete sign-in in the terminal/browser, then return here and retry your request."}
  </p>
  {#if controller.error}<p class="text-tool-error" role="alert">{controller.error}</p>{/if}
  {#if continueError}<p class="text-tool-error" role="alert">{continueError}</p>{/if}
</div>
