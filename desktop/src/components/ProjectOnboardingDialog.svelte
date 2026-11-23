<script lang="ts">
  import { invoke, isTauri } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import { createProjectOnboardingActions, loadOnboardingResources } from "../app/project-onboarding-actions";
  import type { AcpClient } from "../lib/acp-client";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import { dialogCancelButtonClass, dialogPrimaryButtonClass, modalBackdropClass } from "../lib/dialog";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { projectIconDataUrl, type ProjectIconImage } from "../lib/project-icon";
  import { projectOnboardingPlan, type OnboardingResource } from "../lib/project-onboarding";
  import { projectName } from "../lib/recent-projects";

  let { workspace, client, pickIcon, generateIcon, saveIcon, onChanged }: {
    workspace: string;
    client: AcpClient | null;
    pickIcon: () => Promise<ProjectIconImage | undefined>;
    generateIcon: (prompt?: string) => Promise<ProjectIconImage>;
    saveIcon: (workspace: string, image: ProjectIconImage) => Promise<void>;
    onChanged: (workspace: string) => void;
  } = $props();

  const lifetime = new AbortController();
  const signal = lifetime.signal;
  let dialog = $state<HTMLDialogElement>();
  let heading = $state<HTMLElement>();
  let open = $state(false);
  let folderId: string | null = null;
  let busy = $state(false);
  let claimed = $state(false);
  let unavailable = $state(false);
  let error = $state("");
  let currentStep = $state("");
  let plan: ReturnType<typeof projectOnboardingPlan> | undefined;
  let git = $state(true);
  let wiki = $state(true);
  let knowledge = $state(true);
  let autoCheck = $state(false);
  let catalog = $state<OnboardingResource[]>();
  let catalogLoading = $state(false);
  let catalogMessage = $state("");
  let selected = $state<string[]>([]);
  let pickedIcon = $state<ProjectIconImage>();
  let iconMode = $state<"initials" | "file" | "generate">("initials");
  let iconPrompt = $state("");
  let picking = $state(false);
  let iconError = $state("");
  const compactButton = "h-7 rounded-md border border-border bg-background px-2 text-xs hover:bg-accent disabled:opacity-40";

  function report(event: string, cause: unknown, target: string) {
    createDiagnosticLogger(() => ({ workspace: target })).warn(`project:onboarding:${event}`, cause);
    return (cause instanceof Error ? cause.message : String(cause)).slice(0, 600);
  }

  onMount(() => {
    const target = workspace;
    if (isTauri()) void invoke<string | null>("project_onboarding_available", { workspace: target }).then(id => {
      if (signal.aborted || !id) return;
      folderId = id;
      open = true;
    }).catch(cause => report("inspect", cause, target));
    return () => lifetime.abort();
  });

  $effect(() => { if (dialog) return activateModalDialog(dialog, () => heading); });

  async function loadCatalog() {
    const backend = client;
    const target = workspace;
    if (!backend || catalogLoading) return;
    catalogLoading = true;
    catalogMessage = "";
    try {
      const result = await loadOnboardingResources(target, backend, signal);
      if (signal.aborted) return;
      catalog = result.resources;
      if (!result.configured) catalogMessage = "No shared Registry is configured. You can connect it later from Registry.";
      else if (!catalog.length) catalogMessage = "No installable global agents or skills.";
    } catch (cause) {
      if (!signal.aborted) catalogMessage = report("catalog", cause, target);
    } finally {
      if (!signal.aborted) catalogLoading = false;
    }
  }

  async function chooseFile() {
    const target = workspace;
    picking = true;
    iconError = "";
    try {
      const image = await pickIcon();
      if (!signal.aborted && image) { pickedIcon = image; iconMode = "file"; }
    } catch (cause) {
      const message = report("pick-icon", cause, target);
      if (!signal.aborted) iconError = message;
    } finally {
      if (!signal.aborted) picking = false;
    }
  }

  async function decide(apply: boolean) {
    if (busy || picking || (apply && (unavailable || catalogLoading))) return;
    if (!apply && (claimed || unavailable)) { open = false; return; }
    const target = workspace;
    busy = true;
    error = "";
    currentStep = "";
    try {
      if (!claimed) {
        const accepted = await invoke<boolean>("claim_project_onboarding", { workspace: target, folderId });
        signal.throwIfAborted();
        if (!accepted) {
          unavailable = true;
          error = "This folder changed or setup has already been handled in another window.";
          return;
        }
        claimed = true;
      }
      if (apply) {
        plan ??= projectOnboardingPlan({
          git, wiki, knowledge, autoCheck,
          resources: catalog?.filter(item => selected.includes(item.id)) ?? [],
          icon: iconMode === "generate" ? { kind: "generate", prompt: iconPrompt.trim() }
            : iconMode === "file" && pickedIcon ? { kind: "file", image: pickedIcon } : undefined,
        }, createProjectOnboardingActions({
          workspace: target, client: () => client, generateIcon, saveIcon: image => saveIcon(target, image),
        }));
        await plan.run(signal, label => { currentStep = label; });
      }
      if (!signal.aborted) open = false;
    } catch (cause) {
      if (signal.aborted) return;
      const message = report("apply", cause, target);
      error = currentStep ? `${currentStep}: ${message}` : message;
    } finally {
      if (!signal.aborted) {
        busy = false;
        if (plan) onChanged(target);
      }
    }
  }
</script>

{#if open}
  <dialog bind:this={dialog} class={modalBackdropClass} aria-labelledby="project-onboarding-heading"
    oncancel={event => { event.preventDefault(); void decide(false); }}>
    <form class="flex max-h-full w-full max-w-[31rem] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      onsubmit={event => { event.preventDefault(); void decide(true); }}>
      <header class="border-b border-border px-4 py-3">
        <h2 id="project-onboarding-heading" bind:this={heading} tabindex="-1" class="break-words text-sm font-semibold">Set up {projectName(workspace)}</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">Choose what Pix should set up in this empty project.</p>
      </header>
      <div class="min-h-0 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        <fieldset disabled={busy || claimed || unavailable} class="space-y-2 disabled:opacity-60">
          <legend class="sr-only">Project features</legend>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={git} /> Initialize Git and add the default .gitignore</label>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={wiki} /> Create a Wiki with a starter index</label>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={knowledge} /> Enable Knowledge indexing</label>
          <p class="pl-5 text-muted-foreground">Includes the Wiki in project search. Does not configure a provider or start a manual embedding run.</p>
          <label class="flex items-center gap-2"><input type="checkbox" disabled={!wiki || !knowledge}
            checked={wiki && knowledge && autoCheck} onchange={event => autoCheck = event.currentTarget.checked} /> Enable background Wiki checks</label>
          <p class="pl-5 text-muted-foreground">Requires Wiki and Knowledge indexing. Model charges may apply.</p>
        </fieldset>
        <fieldset disabled={busy || claimed || unavailable} class="space-y-1.5 border-t border-border pt-2 disabled:opacity-60">
          <legend class="sr-only">Agents and skills</legend>
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">Agents and skills</span>
            {#if !catalog}<button class={compactButton} type="button" disabled={!client || catalogLoading} onclick={() => void loadCatalog()}>{catalogLoading ? "Loading…" : "Browse global Registry"}</button>{/if}
          </div>
          {#if !client && !catalog}<p class="text-muted-foreground">Registry is available when the project backend connects.</p>{/if}
          {#if catalogMessage}<p class="break-words text-muted-foreground" role="status">{catalogMessage}</p>{/if}
          {#if catalog?.length}
            <ul class="max-h-32 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2">
              {#each catalog as resource (resource.id)}
                <li><label class="flex items-baseline gap-2" title={resource.description}><input type="checkbox" value={resource.id} bind:group={selected} />
                  <span class="break-all">{resource.name}</span><span class="text-muted-foreground">{resource.type}</span></label></li>
              {/each}
            </ul>
          {/if}
        </fieldset>
        <fieldset disabled={busy || claimed || unavailable || picking} class="space-y-1.5 border-t border-border pt-2 disabled:opacity-60">
          <legend class="sr-only">Project icon</legend>
          <p class="font-medium">Project icon</p>
          <div class="flex flex-wrap items-center gap-1.5">
            <button class={compactButton} type="button" aria-pressed={iconMode === "initials"} class:bg-panel-selected={iconMode === "initials"} onclick={() => iconMode = "initials"}>Use initials</button>
            <button class={compactButton} type="button" aria-pressed={iconMode === "file"} class:bg-panel-selected={iconMode === "file"} onclick={() => void chooseFile()}>{picking ? "Choosing…" : "Choose file…"}</button>
            <button class={compactButton} type="button" aria-pressed={iconMode === "generate"} class:bg-panel-selected={iconMode === "generate"} onclick={() => iconMode = "generate"}>Generate with AI</button>
            {#if iconMode === "file" && pickedIcon}<img src={projectIconDataUrl(pickedIcon)} alt="Project icon preview" class="h-7 w-7 rounded-sm object-cover" />{/if}
          </div>
          {#if iconMode === "generate"}
            <label class="block"><span class="sr-only">Optional icon prompt</span><textarea rows="2" maxlength="1000" placeholder="Optional icon prompt" bind:value={iconPrompt}
              class="block w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none"></textarea></label>
            <p class="text-muted-foreground">On submit, Pix sends the project name, your prompt, and the beginning of its README (if present) to OpenRouter.</p>
          {/if}
          {#if iconError}<p class="break-words text-tool-error" role="alert">{iconError}</p>{/if}
        </fieldset>
        {#if busy && currentStep}<p role="status" aria-live="polite">{currentStep}…</p>{/if}
        {#if error}<p role="alert" class="break-words text-tool-error">{error}</p>{/if}
      </div>
      <footer class="flex justify-end gap-2 border-t border-border px-4 py-2.5">
        <button type="button" class={dialogCancelButtonClass} disabled={busy || picking} onclick={() => void decide(false)}>{claimed || unavailable ? "Close" : "Skip"}</button>
        {#if !unavailable}<button type="submit" class={dialogPrimaryButtonClass} disabled={busy || picking || catalogLoading}>{claimed && error ? "Retry" : "Set up project"}</button>{/if}
      </footer>
    </form>
  </dialog>
{/if}
