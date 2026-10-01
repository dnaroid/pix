<script lang="ts">
  import FileCode from "@lucide/svelte/icons/file-code";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Save from "@lucide/svelte/icons/save";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy, onMount, untrack } from "svelte";
  import { SETTINGS_GROUPS } from "../../lib/settings-navigation";
  import {
    cacheSettingsDraft,
    parseSettingsSchema,
    parseSettingsSource,
    reconcileSavedSettingsDraft,
    settingsEditorCache,
    settingsSourceIssues,
    type SettingsConfigDocument,
    type SettingsConfigKind,
    type SettingsDraftDocument,
  } from "../../lib/settings";
  import { modelThinkingConfigState } from "../../lib/model-thinking";
  import DesktopSettingsEditor, { type DesktopSettingsSection } from "./DesktopSettingsEditor.svelte";
  import ToolsSuiteSettingsEditor, { type ToolsSuiteSettingsSection } from "./ToolsSuiteSettingsEditor.svelte";

  let {
    configOptions,
    kind,
    onOpenUserConfig,
    onIndicatorChange,
  }: {
    configOptions: readonly SessionConfigOption[];
    kind: SettingsConfigKind;
    onOpenUserConfig: (kind: SettingsConfigKind) => void;
    onIndicatorChange?: (error: string | null) => void;
  } = $props();

  const initialCache = settingsEditorCache();
  // Each mounted editor owns a single file and its load/save generations.
  const activeKind = untrack(() => kind);
  const sections = SETTINGS_GROUPS[activeKind].sections;
  let active = $state<SettingsDraftDocument | undefined>(initialCache.drafts[activeKind]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let indicatorDisposed = false;
  let loadGeneration = 0;
  let saveGeneration = 0;

  const settingsModels = $derived(modelThinkingConfigState(configOptions).models);
  const parsed = $derived(active ? parseSettingsSource(active.source) : { value: {}, errors: [] });
  const issues = $derived(active ? settingsSourceIssues(active.source, active.schemaObject) : []);
  const dirty = $derived(Boolean(active && active.source !== active.savedSource));

  $effect(() => {
    const indicatorError = error ?? issues[0] ?? null;
    queueMicrotask(() => {
      if (!indicatorDisposed) onIndicatorChange?.(indicatorError);
    });
  });

  onMount(() => {
    void loadConfig();
  });

  onDestroy(() => {
    indicatorDisposed = true;
    loadGeneration += 1;
    saveGeneration += 1;
    onIndicatorChange?.(null);
  });

  function setDraft(next: SettingsDraftDocument): void {
    active = next;
    cacheSettingsDraft(activeKind, next);
  }

  async function loadConfig(force = false): Promise<void> {
    if (!force && active) return;
    const generation = ++loadGeneration;
    loading = true;
    error = null;
    try {
      const document = await invoke<SettingsConfigDocument>("read_user_config", { kind: activeKind });
      if (indicatorDisposed || generation !== loadGeneration) return;
      const schemaObject = parseSettingsSchema(document.schema);
      setDraft({ ...document, source: document.content, savedSource: document.content, schemaObject });
    } catch (caught) {
      if (!indicatorDisposed && generation === loadGeneration) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      if (!indicatorDisposed && generation === loadGeneration) loading = false;
    }
  }

  function updateSource(source: string): void {
    const current = active;
    if (!current) return;
    setDraft({ ...current, source });
  }

  function openInEditor(): void {
    if (!active || dirty) return;
    onOpenUserConfig(activeKind);
  }

  function reload(): void {
    if (saving) return;
    if (dirty && !window.confirm("Discard unsaved settings changes and reload this config?")) return;
    void loadConfig(true);
  }

  async function save(): Promise<void> {
    const kind = activeKind;
    const current = active;
    if (!current || !dirty || issues.length > 0 || saving || loading) return;
    const savedSource = current.source;
    const generation = ++saveGeneration;
    saving = true;
    error = null;
    try {
      const result = await invoke<{ written: boolean; document: SettingsConfigDocument }>("write_user_config_if_unchanged", {
        kind,
        expectedContent: current.savedSource,
        content: savedSource,
      });
      if (indicatorDisposed || generation !== saveGeneration) return;
      if (!result.written) {
        error = "This config changed on disk. Reload it before saving to avoid overwriting newer changes.";
        return;
      }
      const latest = active;
      if (!latest) return;
      setDraft(reconcileSavedSettingsDraft(latest, savedSource, result.document));
    } catch (caught) {
      if (!indicatorDisposed && generation === saveGeneration) error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (!indicatorDisposed && generation === saveGeneration) saving = false;
    }
  }
</script>

<section class="bg-sidebar text-sidebar-foreground" aria-label={SETTINGS_GROUPS[activeKind].label} data-settings-config={activeKind}>
  <header class="sticky top-0 z-10 border-b border-sidebar-border bg-panel px-2.5 py-2">
    <div class="flex min-w-0 flex-wrap items-center gap-1.5">
      <span class="min-w-0 flex-1 text-xs font-medium text-foreground">{SETTINGS_GROUPS[activeKind].label}</span>
      {#if active && !active.exists}<span class="rounded border border-border px-1 py-0.5 text-xs text-muted-foreground">new file</span>{/if}
      {#if dirty}<span class="ml-auto text-xs font-medium text-tool-warning">Unsaved</span>{/if}
      <button
        class="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        type="button"
        title="Reload settings from disk"
        aria-label={`Reload ${SETTINGS_GROUPS[activeKind].label} settings from disk`}
        onclick={reload}
        disabled={loading || saving}
      ><RefreshCw class={["h-3.5 w-3.5", loading ? "animate-spin" : ""]} aria-hidden="true" /></button>
      <button
        class="h-7 shrink-0 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        type="button"
        aria-label={`Save ${SETTINGS_GROUPS[activeKind].label} settings`}
        onclick={() => void save()}
        disabled={!active || !dirty || issues.length > 0 || saving || loading}
      >{saving ? "Saving…" : "Save"}</button>
    </div>
    <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={active?.path}>{active?.path ?? "Resolving config path…"}</div>
    {#if activeKind === "desktop"}
      <p class="mt-1 text-xs leading-4 text-muted-foreground">Independent Desktop profile. TUI <span class="font-mono">pix.jsonc</span> is never inherited.</p>
    {/if}
  </header>

  <div>
    {#if loading && !active}
      <div class="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading settings…</div>
    {:else if error && !active}
      <div class="px-3 py-8 text-center"><TriangleAlert class="mx-auto mb-2 h-5 w-5 text-tool-error" aria-hidden="true" /><p class="text-xs font-medium text-foreground">Could not load settings</p><p class="mt-1 text-xs leading-4 text-tool-error">{error}</p></div>
    {:else if active}
      {#if parsed.errors.length > 0}
        <div class="m-2.5 rounded-lg border border-tool-error/25 bg-tool-error/5 p-3">
          <div class="flex items-start gap-2">
            <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0 text-tool-error" aria-hidden="true" />
            <div class="min-w-0">
              <h2 class="text-xs font-semibold text-foreground">JSONC needs repair</h2>
              <p class="mt-1 text-xs leading-4 text-muted-foreground">The structured editor is disabled until the config parses. Open the config in the editor tab to repair the source without losing comments.</p>
              <button
                class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
                type="button"
                onclick={openInEditor}
                disabled={dirty}
                title={dirty ? "Save settings before opening the config file" : "Open config in editor tab"}
              ><FileCode class="h-3.5 w-3.5" aria-hidden="true" />Open in editor</button>
            </div>
          </div>
        </div>
      {/if}
      {#each sections as chapter (chapter.id)}
        <section id={`settings-${activeKind}-${chapter.id}`} data-settings-section={`${activeKind}-${chapter.id}`} data-settings-title={chapter.label}>
        {#if chapter.id === "advanced"}
        <div class="px-2.5 py-2.5"><h2 class="text-sm font-semibold text-foreground">Advanced</h2><p class="mt-0.5 text-xs leading-4 text-muted-foreground">Open the complete config source in the editor.</p></div>
        <div class="p-2.5" data-settings-field="Advanced Open in editor complete config JSONC source">
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-panel-strong px-3 text-xs font-medium text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
            type="button"
            onclick={openInEditor}
            disabled={dirty}
            title={dirty ? "Save settings before opening the config file" : "Open config in editor tab"}
          ><FileCode class="h-3.5 w-3.5" aria-hidden="true" />Open in editor</button>
        </div>
        {:else if parsed.errors.length === 0}
          {#if activeKind === "desktop"}
            <DesktopSettingsEditor source={active.source} schema={active.schemaObject} models={settingsModels} section={chapter.id as DesktopSettingsSection} onChange={updateSource} />
          {:else}
            <ToolsSuiteSettingsEditor source={active.source} schema={active.schemaObject} models={settingsModels} section={chapter.id as ToolsSuiteSettingsSection} onChange={updateSource} />
          {/if}
        {/if}
        </section>
      {/each}
    {/if}
  </div>

  <div class="border-t border-sidebar-border bg-chrome px-2.5 py-2">
    {#if error}
      <div class="mb-2 rounded-md border border-tool-error/25 bg-tool-error/5 px-2 py-1.5 text-xs leading-4 text-tool-error">{error}</div>
    {/if}
    {#if active && issues.length > 0}
      <div class="mb-2 flex items-start gap-1.5 text-xs leading-4 text-tool-error"><TriangleAlert class="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /><span>{issues[0]}{issues.length > 1 ? ` · ${issues.length - 1} more` : ""}</span></div>
    {/if}
    <div class="flex items-center gap-2">
      <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">Changes may require a new or reloaded session.</span>
      <button
        class="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        aria-label={`Save ${SETTINGS_GROUPS[activeKind].label} settings`}
        onclick={() => void save()}
        disabled={!active || !dirty || issues.length > 0 || saving || loading}
      >{#if saving}<RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}<Save class="h-3 w-3" aria-hidden="true" />{/if}{saving ? "Saving…" : "Save"}</button>
    </div>
  </div>
</section>
