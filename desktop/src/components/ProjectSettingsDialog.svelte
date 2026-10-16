<script lang="ts">
  import { dialogCancelButtonClass, dialogPrimaryButtonClass, modalBackdropClass } from "../lib/dialog";
  import { iconButtonClass } from "../lib/icon-button";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import X from "@lucide/svelte/icons/x";
  import ImageIcon from "@lucide/svelte/icons/image";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Pipette from "@lucide/svelte/icons/pipette";
  import { vividColorFromImageUrl } from "../lib/project-logo-color";
  import { onDestroy, untrack } from "svelte";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { normalizeProjectColor } from "../lib/project-colors";
  import { projectAbbreviation, projectFolderHue, projectName } from "../lib/recent-projects";
  import {
    projectIconDataUrl,
    type ProjectIconChange,
    type ProjectIconImage,
    type ProjectSettingsDraft,
  } from "../lib/project-icon";
  import ProjectFolderIcon from "./ProjectFolderIcon.svelte";

  let {
    workspace,
    color,
    icon,
    saving,
    error,
    onSave,
    onPickIcon,
    onGenerateIcon,
    onClose,
  }: {
    workspace: string;
    color?: string;
    /** Data URL of the stored project logo, if any. */
    icon?: string;
    saving: boolean;
    error: string | null;
    onSave: (draft: ProjectSettingsDraft) => void;
    onPickIcon: () => Promise<ProjectIconImage | undefined>;
    onGenerateIcon: (prompt?: string) => Promise<ProjectIconImage>;
    onClose: () => void;
  } = $props();

  let dialogElement: HTMLDialogElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let custom = $state(untrack(() => color !== undefined));
  let draftColor = $state(untrack(() => color ?? "#7aa2f7"));

  let iconMode = $state<"initials" | "image">(untrack(() => icon ? "image" : "initials"));
  let draftIcon = $state<ProjectIconImage | undefined>(undefined);
  let iconBusy = $state<"pick" | "generate" | null>(null);
  let iconError = $state<string | null>(null);
  let iconPrompt = $state("");
  const MAX_ICON_PROMPT_CHARS = 1000;
  let iconRequest = 0;
  let destroyed = false;
  onDestroy(() => { destroyed = true; iconRequest += 1; });

  const iconPreview = $derived(draftIcon ? projectIconDataUrl(draftIcon) : icon);
  const shownIcon = $derived(iconMode === "image" ? iconPreview : undefined);
  const normalizedColor = $derived(normalizeProjectColor(draftColor));
  const previewColor = $derived(custom ? normalizedColor : undefined);
  const saveDisabled = $derived(
    saving || iconBusy !== null || (custom && !normalizedColor) || (iconMode === "image" && !iconPreview),
  );

  async function requestIcon(kind: "pick" | "generate"): Promise<void> {
    if (iconBusy || saving) return;
    const request = ++iconRequest;
    iconBusy = kind;
    iconError = null;
    try {
      const image = kind === "pick" ? await onPickIcon() : await onGenerateIcon(iconPrompt.trim() || undefined);
      if (destroyed || request !== iconRequest) return;
      if (image) {
        draftIcon = image;
        iconMode = "image";
      }
    } catch (failure) {
      if (destroyed || request !== iconRequest) return;
      iconError = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (!destroyed && request === iconRequest) iconBusy = null;
    }
  }

  function iconChange(): ProjectIconChange {
    if (iconMode === "initials") return icon ? { kind: "none" } : { kind: "keep" };
    return draftIcon ? { kind: "image", image: draftIcon } : { kind: "keep" };
  }

  $effect(() => {
    const dialog = dialogElement;
    if (!dialog) return;
    return activateModalDialog(dialog, () => closeButton);
  });

  function pickerColor(value: string): string {
    const normalized = normalizeProjectColor(value);
    if (!normalized) return "#7aa2f7";
    if (normalized.length === 4 || normalized.length === 5) {
      return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`;
    }
    return normalized.slice(0, 7);
  }

  let logoColorBusy = $state(false);
  let logoColorError = $state<string | null>(null);

  async function colorFromLogo(): Promise<void> {
    const source = iconPreview;
    if (!source || logoColorBusy) return;
    logoColorBusy = true;
    logoColorError = null;
    try {
      const color = await vividColorFromImageUrl(source);
      if (destroyed || source !== iconPreview) return;
      if (color) draftColor = color;
      else logoColorError = "The logo has no usable color.";
    } catch {
      if (!destroyed) logoColorError = "Could not read colors from the logo.";
    } finally {
      if (!destroyed) logoColorBusy = false;
    }
  }

  function chooseCustom(): void {
    custom = true;
    if (!normalizedColor) draftColor = "#7aa2f7";
  }

  function submit(): void {
    if (saveDisabled) return;
    onSave({ color: custom ? normalizedColor : undefined, icon: iconChange() });
  }

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    submit();
  }
</script>

<dialog
  bind:this={dialogElement}
  class={modalBackdropClass}
  aria-label="Project settings"
  oncancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
  onclick={(event) => { if (!saving && event.target === event.currentTarget) onClose(); }}
>
  <form class="w-[430px] max-w-[calc(100vw-40px)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md" onsubmit={handleSubmit}>
    <header class="flex h-10 items-center gap-2 border-b border-border bg-chrome px-3">
      <ProjectFolderIcon project={workspace} color={previewColor} class="h-4 w-4 shrink-0" />
      <strong class="min-w-0 flex-1 truncate text-xs font-semibold">Project settings</strong>
      <button
        bind:this={closeButton}
        class={iconButtonClass("md", "chrome")}
        type="button"
        aria-label="Close project settings"
        disabled={saving}
        onclick={onClose}
      ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
    </header>

    <div class="space-y-4 p-4">
      <div class="min-w-0">
        <div class="truncate text-xs font-medium">{projectName(workspace)}</div>
        <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={workspace}>{workspace}</div>
      </div>

      <section class="space-y-2" aria-labelledby="project-logo-heading">
        <div>
          <h2 id="project-logo-heading" class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Logo</h2>
          <p class="mt-1 text-xs leading-4 text-muted-foreground">Shown in the titlebar and the recent-project list.</p>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <button
            class={["flex h-10 items-center gap-2 rounded-md border px-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring", iconMode === "initials" ? "border-primary/60 bg-panel-selected" : "border-border bg-background hover:bg-accent"]}
            type="button"
            aria-pressed={iconMode === "initials"}
            onclick={() => iconMode = "initials"}
          >
            <span
              class="project-logo-initials grid h-5 w-5 shrink-0 place-items-center rounded-sm border border-border font-mono text-[10px] font-semibold"
              style:--project-logo-hue={projectFolderHue(workspace)}
              style:--project-logo-color={previewColor}
              aria-hidden="true"
            >{projectAbbreviation(workspace)}</span>
            <span class="min-w-0"><strong class="block text-xs font-medium">Initials</strong><small class="block truncate text-xs text-muted-foreground">From project name</small></span>
          </button>
          <button
            class={["flex h-10 items-center gap-2 rounded-md border px-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring", iconMode === "image" ? "border-primary/60 bg-panel-selected" : "border-border bg-background hover:bg-accent"]}
            type="button"
            aria-pressed={iconMode === "image"}
            onclick={() => iconMode = "image"}
          >
            {#if iconPreview}
              <img class="h-5 w-5 shrink-0 rounded-sm object-cover" src={iconPreview} alt="" />
            {:else}
              <ImageIcon class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {/if}
            <span class="min-w-0"><strong class="block text-xs font-medium">Image</strong><small class="block truncate text-xs text-muted-foreground">File or AI-generated</small></span>
          </button>
        </div>

        {#if iconMode === "image"}
          <div class="flex items-center gap-3 rounded-md border border-border bg-background p-2">
            <div class="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted/40" data-project-logo-preview>
              {#if iconBusy === "generate"}
                <RotateCw class="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
              {:else if iconPreview}
                <img class="h-full w-full object-cover" src={iconPreview} alt="Project logo preview" />
              {:else}
                <ImageIcon class="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              {/if}
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <button
                class="flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                disabled={iconBusy !== null || saving}
                onclick={() => void requestIcon("pick")}
              ><ImageIcon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Choose file…</button>
              <button
                class="flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                disabled={iconBusy !== null || saving}
                onclick={() => void requestIcon("generate")}
              >
                {#if iconBusy === "generate"}
                  <RotateCw class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />Generating…
                {:else}
                  <Sparkles class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{draftIcon || icon ? "Generate another" : "Generate with AI"}
                {/if}
              </button>
            </div>
          </div>
          <label class="block">
            <span class="sr-only">Optional logo prompt</span>
            <textarea
              class="block min-h-14 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs leading-4 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
              rows="2"
              maxlength={MAX_ICON_PROMPT_CHARS}
              placeholder="Optional prompt, e.g. “minimal fox head, teal on dark”"
              disabled={iconBusy !== null || saving}
              bind:value={iconPrompt}
              data-project-logo-prompt
            ></textarea>
          </label>
          <p class="text-xs leading-4 text-muted-foreground">AI generation sends the project name, your prompt, and the beginning of its README to OpenRouter. Saved as <span class="font-mono">.pi/project-icon.*</span>.</p>
          {#if iconError}<p class="text-xs leading-4 text-tool-error">{iconError}</p>{/if}
        {/if}
      </section>

      <section class="space-y-2" aria-labelledby="project-color-heading">
        <div>
          <h2 id="project-color-heading" class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Identity color</h2>
          <p class="mt-1 text-xs leading-4 text-muted-foreground">Used by the titlebar, status-bar project name, and recent-project folders.</p>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <button
            class={["flex h-10 items-center gap-2 rounded-md border px-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring", !custom ? "border-primary/60 bg-panel-selected" : "border-border bg-background hover:bg-accent"]}
            type="button"
            aria-pressed={!custom}
            onclick={() => custom = false}
          >
            <ProjectFolderIcon project={workspace} class="h-4 w-4 shrink-0" />
            <span class="min-w-0"><strong class="block text-xs font-medium">Automatic</strong><small class="block truncate text-xs text-muted-foreground">From project path</small></span>
          </button>
          <button
            class={["flex h-10 items-center gap-2 rounded-md border px-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring", custom ? "border-primary/60 bg-panel-selected" : "border-border bg-background hover:bg-accent"]}
            type="button"
            aria-pressed={custom}
            onclick={chooseCustom}
          >
            <span class="h-4 w-4 shrink-0 rounded-sm border border-border" style:background-color={normalizedColor ?? "#7aa2f7"}></span>
            <span class="min-w-0"><strong class="block text-xs font-medium">Custom</strong><small class="block truncate text-xs text-muted-foreground">Workspace override</small></span>
          </button>
        </div>

        {#if custom}
          <div class="flex items-center gap-2 rounded-md border border-border bg-background p-2">
            <input
              class="h-8 w-10 shrink-0 rounded border border-border bg-transparent p-0.5"
              type="color"
              value={pickerColor(draftColor)}
              aria-label="Choose project color"
              oninput={(event) => draftColor = event.currentTarget.value}
            />
            <label class="min-w-0 flex-1">
              <span class="sr-only">Project color hex value</span>
              <input
                class="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                value={draftColor}
                maxlength="9"
                spellcheck="false"
                autocomplete="off"
                placeholder="#7aa2f7"
                oninput={(event) => draftColor = event.currentTarget.value}
              />
            </label>
            <button
              class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              title={iconPreview ? "Use the most vivid prominent color of the logo" : "Choose a logo image first"}
              disabled={!iconPreview || logoColorBusy || saving}
              onclick={() => void colorFromLogo()}
              data-project-color-from-logo
            ><Pipette class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />From logo</button>
          </div>
          {#if logoColorError}<p class="text-xs text-tool-error">{logoColorError}</p>{/if}
          {#if !normalizedColor}
            <p class="text-xs text-tool-error">Use #RGB, #RGBA, #RRGGBB, or #RRGGBBAA.</p>
          {/if}
        {/if}
      </section>

      <p class="font-mono text-xs text-muted-foreground">.pi/workspace.jsonc</p>
      {#if error}<p class="rounded-md border border-tool-error/30 bg-tool-error/5 px-2.5 py-2 text-xs leading-4 text-tool-error">{error}</p>{/if}
    </div>

    <footer class="flex h-12 items-center justify-end gap-2 border-t border-border bg-chrome/60 px-3">
      <button class={dialogCancelButtonClass} type="button" disabled={saving} onclick={onClose}>Cancel</button>
      <button class={dialogPrimaryButtonClass} type="submit" disabled={saveDisabled}>
        {#if saving}<RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{/if}
        {saving ? "Saving…" : "Save"}
      </button>
    </footer>
  </form>
</dialog>

<style>
  .project-logo-initials {
    background-color: var(--project-logo-color, oklch(0.62 0.15 var(--project-logo-hue)));
    color: var(--primary-foreground);
  }

  @media (prefers-color-scheme: dark) {
    .project-logo-initials {
      background-color: var(--project-logo-color, oklch(0.74 0.13 var(--project-logo-hue)));
    }
  }
</style>
