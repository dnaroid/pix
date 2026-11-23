<script lang="ts">
  import { modalBackdropClass } from "../lib/dialog";
  import CheckCircle2 from "@lucide/svelte/icons/circle-check";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import { onMount } from "svelte";
  import { claudeLoginCommand } from "../lib/claude-login-recovery";
  import {
    ANTIGRAVITY_PROVIDER_ID,
    importedOpenCodeProviders,
    importCodexApiKey,
    importOpenCodeCredentials,
    inspectDesktopBootstrap,
    type DesktopBootstrapSnapshot,
  } from "../lib/desktop-bootstrap";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { completeDesktopOnboarding, desktopOnboardingCompleted } from "../lib/desktop-onboarding";

  let {
    onCredentialsChanged,
    onOpenClaudeLoginTerminal,
    onError,
    onReady,
  }: {
    onCredentialsChanged: () => void | Promise<void>;
    /** Opens the project terminal with a command; unavailable without an open project. */
    onOpenClaudeLoginTerminal?: (command: string) => Promise<void>;
    onError?: (error: unknown) => void;
    onReady?: () => void;
  } = $props();

  let dialogElement = $state<HTMLDialogElement | null>(null);
  let finishButton = $state<HTMLButtonElement | null>(null);
  let visible = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let snapshot = $state<DesktopBootstrapSnapshot | null>(null);
  let busy = $state<"opencode" | "codex" | null>(null);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);

  const piReady = $derived(snapshot?.runtime.ready === true);
  const opencodeDetected = $derived(Boolean(snapshot?.opencode.authDetected || snapshot?.opencode.antigravityDetected));
  const claudeStatus = $derived(snapshot?.claudeCode?.status);
  const claudeCanSignIn = $derived(claudeStatus === "logged-out" || claudeStatus === "unknown");
  const antigravityConnected = $derived(snapshot?.pi.providers.includes(ANTIGRAVITY_PROVIDER_ID) === true);

  $effect(() => {
    if (!visible || !dialogElement) return;
    return activateModalDialog(dialogElement, () => finishButton);
  });

  onMount(() => {
    let disposed = false;
    void (async () => {
      try {
        const complete = await desktopOnboardingCompleted();
        if (disposed) return;
        if (complete) { onReady?.(); return; }
        visible = true;
        await refresh();
      } catch (cause) {
        if (disposed) return;
        visible = true;
        error = cause instanceof Error ? cause.message : String(cause);
      }
    })();
    return () => { disposed = true; };
  });

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      snapshot = await inspectDesktopBootstrap();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  async function runAction(kind: "opencode" | "codex"): Promise<void> {
    if (busy || saving) return;
    busy = kind;
    error = null;
    message = null;
    try {
      if (kind === "opencode") {
        const result = await importOpenCodeCredentials();
        const imported = importedOpenCodeProviders(result);
        message = imported.length > 0
          ? `Imported into Pi: ${[...new Set(imported)].join(", ")}.`
          : result.wroteAuth
            ? "OpenCode credentials were imported into Pi."
            : "Nothing new was imported; existing Pi credentials were kept.";
        if (result.wroteAuth) await onCredentialsChanged();
      } else if (kind === "codex") {
        const result = await importCodexApiKey();
        message = result.status === "imported"
          ? "Imported Codex OPENAI_API_KEY into Pi."
          : result.status === "already-imported"
            ? "The Codex API key is already configured in Pi."
            : result.status === "auth-exists"
              ? "Pi already has OpenAI credentials, so they were kept unchanged."
              : "No static OPENAI_API_KEY was found in Codex.";
        if (result.status === "imported") await onCredentialsChanged();
      }
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }

  async function finish(): Promise<boolean> {
    if (saving || busy) return false;
    saving = true;
    error = null;
    try {
      await completeDesktopOnboarding();
      visible = false;
      onReady?.();
      return true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      saving = false;
    }
  }

  /**
   * The terminal lives in the workbench behind this modal, so sign-in first
   * completes setup, then runs Claude's own login there. Claude CLI owns the
   * browser flow and credential storage.
   */
  async function signInToClaude(): Promise<void> {
    const openTerminal = onOpenClaudeLoginTerminal;
    if (!openTerminal || !(await finish())) return;
    try {
      await openTerminal(claudeLoginCommand());
    } catch (cause) {
      onError?.(cause);
    }
  }

  function retainUntilContinue(event: Event): void {
    event.preventDefault();
  }
</script>

{#if visible}
  <dialog
    bind:this={dialogElement}
    class={modalBackdropClass}
    aria-labelledby="desktop-bootstrap-title"
    oncancel={retainUntilContinue}
  >
    <div class="w-[560px] max-w-[calc(100vw-40px)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
      <header class="border-b border-border bg-chrome px-4 py-3">
        <div class="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">First run</div>
        <h2 id="desktop-bootstrap-title" class="mt-1 text-base font-semibold text-foreground">Prepare Pix Desktop</h2>
        <p class="mt-1 text-xs leading-5 text-muted-foreground">
          Pix ships its own Node, Pi, and tools suite. Optional integrations stay in your user profile.
        </p>
      </header>

      <div class="max-h-[min(620px,70vh)] space-y-3 overflow-y-auto p-4">
        <section class="rounded-md border border-border bg-background p-3">
          <div class="flex items-start gap-2.5">
            {#if loading}
              <RotateCw class="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
            {:else if piReady}
              <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0 text-tool-success" aria-hidden="true" />
            {:else}
              <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-tool-error" aria-hidden="true" />
            {/if}
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium">Pi runtime + tools suite</div>
              <p class="mt-0.5 text-xs leading-4 text-muted-foreground">
                {piReady
                  ? "Bundled and ready. No system Node.js, npm, or global Pi install is required."
                  : loading ? "Checking the bundled runtime…" : "The bundled runtime could not be verified."}
              </p>
              {#if snapshot}
                <p class="mt-1 truncate font-mono text-xs text-muted-foreground" title={snapshot.pi.agentDir}>{snapshot.pi.agentDir}</p>
                {#if snapshot.pi.providers.length > 0}
                  <p class="mt-1 text-xs text-muted-foreground">Pi auth: {snapshot.pi.providers.join(", ")}</p>
                {/if}
              {/if}
            </div>
          </div>
        </section>

        <section class="rounded-md border border-border bg-background p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium">OpenCode credentials</div>
              <p class="mt-0.5 text-xs leading-4 text-muted-foreground">
                {opencodeDetected
                  ? "Compatible providers were found. Import keeps any existing Pi credential unless it is identical."
                  : "No supported OpenCode credentials were detected."}
              </p>
              {#if snapshot?.opencode.providers.length}
                <p class="mt-1 text-xs text-muted-foreground">{snapshot.opencode.providers.join(", ")}</p>
              {/if}
            </div>
            <button
              class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-xs font-medium hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              disabled={!opencodeDetected || busy !== null || saving}
              onclick={() => void runAction("opencode")}
            >
              {#if busy === "opencode"}<RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{/if}
              Import
            </button>
          </div>
        </section>

        <section class="rounded-md border border-border bg-background p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium">Codex API key (OPENAI_API_KEY)</div>
              {#if snapshot?.codex.apiKeyDetected}
                <p class="mt-0.5 text-xs leading-4 text-muted-foreground">A static OPENAI_API_KEY is available and can be copied into Pi without replacing existing Pi auth.</p>
              {:else if snapshot?.codex.oauthDetected}
                <p class="mt-0.5 text-xs leading-4 text-muted-foreground">ChatGPT/Codex OAuth was detected. Pix does not copy rotating OAuth refresh tokens between auth stores; authenticate Pi separately for this provider.</p>
              {:else}
                <p class="mt-0.5 text-xs leading-4 text-muted-foreground">No static OPENAI_API_KEY was found in Codex auth.json. Only that key can be imported, into the Pi openai provider.</p>
              {/if}
            </div>
            <button
              class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-xs font-medium hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              disabled={!snapshot?.codex.apiKeyDetected || busy !== null || saving}
              onclick={() => void runAction("codex")}
            >
              {#if busy === "codex"}<RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{/if}
              Import key
            </button>
          </div>
        </section>

        <section class="rounded-md border border-border bg-background p-3" data-bootstrap-claude-code>
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium">Claude Code</div>
              <p class="mt-0.5 text-xs leading-4 text-muted-foreground">
                {#if !snapshot}
                  {loading ? "Checking the Claude Code CLI…" : "Claude Code status is unavailable."}
                {:else if claudeStatus === "ready"}
                  Claude Code CLI is installed and signed in. Its models are available through your subscription.
                {:else if claudeStatus === "logged-out"}
                  Claude Code CLI is installed but not signed in. Sign-in runs Claude's own login; Pix never reads its tokens.
                {:else if claudeStatus === "missing"}
                  Claude Code CLI was not found on PATH. Install it (or set PI_CLAUDE_CODE_PROVIDER_PATH) to use Claude models.
                {:else}
                  Claude Code CLI was found, but its login state could not be determined.
                {/if}
              </p>
              {#if claudeCanSignIn && !onOpenClaudeLoginTerminal}
                <p class="mt-1 text-xs text-muted-foreground">Open a project to sign in from its terminal, or run <code class="font-mono">claude auth login</code>.</p>
              {/if}
            </div>
            {#if claudeStatus === "ready"}
              <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0 text-tool-success" aria-label="Ready" />
            {:else}
              <button
                class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-xs font-medium hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                type="button"
                disabled={!claudeCanSignIn || !onOpenClaudeLoginTerminal || busy !== null || saving}
                onclick={() => void signInToClaude()}
              >Sign in</button>
            {/if}
          </div>
        </section>

        <section class="rounded-md border border-border bg-background p-3" data-bootstrap-antigravity>
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium">Antigravity</div>
              <p class="mt-0.5 text-xs leading-4 text-muted-foreground">
                {#if antigravityConnected}
                  An Antigravity account is connected in Pi.
                {:else}
                  Not connected. Import it from OpenCode above, or run <code class="font-mono">/antigravity-add-account</code> in a session.
                {/if}
              </p>
            </div>
            {#if antigravityConnected}
              <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0 text-tool-success" aria-label="Connected" />
            {/if}
          </div>
        </section>

        {#if message}<p class="rounded-md border border-border bg-panel px-3 py-2 text-xs leading-4 text-foreground">{message}</p>{/if}
        {#if error}<p class="rounded-md border border-tool-error/30 bg-tool-error/5 px-3 py-2 text-xs leading-4 text-tool-error">{error}</p>{/if}
      </div>

      <footer class="flex h-12 items-center justify-between gap-3 border-t border-border bg-chrome/60 px-4">
        <span class="text-xs text-muted-foreground">Optional steps can be configured later.</span>
        <button
          bind:this={finishButton}
          class="inline-flex h-8 min-w-24 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
          type="button"
          disabled={busy !== null || saving}
          onclick={finish}
        >Continue</button>
      </footer>
    </div>
  </dialog>
{/if}
