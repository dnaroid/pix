<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Save from "@lucide/svelte/icons/save";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy, onMount } from "svelte";
  import {
    parseSettingsSchema,
    parseSettingsSource,
    reconcileSavedSettingsDraft,
    settingsEditorCache,
    settingsSourceIssues,
    updateSettingsEditorCache,
    type SettingsConfigDocument,
    type SettingsConfigKind,
    type SettingsDraftDocument,
  } from "../lib/settings";
  import { modelThinkingConfigState } from "../lib/model-thinking";
  import DesktopSettingsEditor from "./settings/DesktopSettingsEditor.svelte";
  import SettingsSectionNav from "./settings/SettingsSectionNav.svelte";
  import ToolsSuiteSettingsEditor from "./settings/ToolsSuiteSettingsEditor.svelte";

  type DesktopSection = "general" | "models" | "assistant" | "voice" | "editor" | "source-control" | "advanced";
  type ToolsSection = "general" | "automation" | "dcp" | "context" | "integrations" | "advanced";

  const DESKTOP_SECTIONS = [
    { id: "general", label: "General" },
    { id: "models", label: "Models" },
    { id: "assistant", label: "Assistant" },
    { id: "voice", label: "Voice" },
    { id: "editor", label: "Editor" },
    { id: "source-control", label: "Git" },
    { id: "advanced", label: "Advanced" },
  ] as const;
  const TOOLS_SECTIONS = [
    { id: "general", label: "General" },
    { id: "automation", label: "Automation" },
    { id: "dcp", label: "DCP" },
    { id: "context", label: "Context" },
    { id: "integrations", label: "Integrations" },
    { id: "advanced", label: "Advanced" },
  ] as const;

  let {
    configOptions,
    onIndicatorChange,
  }: {
    configOptions: readonly SessionConfigOption[];
    onIndicatorChange?: (error: string | null) => void;
  } = $props();

  const initialCache = settingsEditorCache();
  let activeKind = $state<SettingsConfigKind>(initialCache.activeKind);
  let drafts = $state<Partial<Record<SettingsConfigKind, SettingsDraftDocument>>>(initialCache.drafts);
  let desktopSection = $state<DesktopSection>("general");
  let toolsSection = $state<ToolsSection>("general");
  let loadingKind = $state<SettingsConfigKind | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let indicatorDisposed = false;
  const loadGenerations: Record<SettingsConfigKind, number> = { desktop: 0, "pi-tools-suite": 0 };
  let saveGeneration = 0;

  const active = $derived(drafts[activeKind]);
  const settingsModels = $derived(modelThinkingConfigState(configOptions).models);
  const parsed = $derived(active ? parseSettingsSource(active.source) : { value: {}, errors: [] });
  const issues = $derived(active ? settingsSourceIssues(active.source, active.schemaObject) : []);
  const dirty = $derived(Boolean(active && active.source !== active.savedSource));
  const advanced = $derived(activeKind === "desktop" ? desktopSection === "advanced" : toolsSection === "advanced");

  $effect(() => {
    const indicatorError = error ?? issues[0] ?? null;
    queueMicrotask(() => {
      if (!indicatorDisposed) onIndicatorChange?.(indicatorError);
    });
  });

  onMount(() => {
    void loadConfig(activeKind);
  });

  onDestroy(() => {
    indicatorDisposed = true;
    loadGenerations.desktop += 1;
    loadGenerations["pi-tools-suite"] += 1;
    saveGeneration += 1;
    onIndicatorChange?.(null);
  });

  function setDrafts(next: Partial<Record<SettingsConfigKind, SettingsDraftDocument>>): void {
    drafts = next;
    updateSettingsEditorCache({ activeKind, drafts: next });
  }

  async function loadConfig(kind: SettingsConfigKind, force = false): Promise<void> {
    if (!force && drafts[kind]) return;
    const generation = ++loadGenerations[kind];
    loadingKind = kind;
    if (activeKind === kind) error = null;
    try {
      const document = await invoke<SettingsConfigDocument>("read_user_config", { kind });
      if (indicatorDisposed || generation !== loadGenerations[kind]) return;
      const schemaObject = parseSettingsSchema(document.schema);
      setDrafts({
        ...drafts,
        [kind]: { ...document, source: document.content, savedSource: document.content, schemaObject },
      });
    } catch (caught) {
      if (!indicatorDisposed && generation === loadGenerations[kind] && activeKind === kind) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      if (!indicatorDisposed && generation === loadGenerations[kind] && loadingKind === kind) loadingKind = null;
    }
  }

  function chooseKind(kind: SettingsConfigKind): void {
    activeKind = kind;
    updateSettingsEditorCache({ activeKind: kind, drafts });
    error = null;
    void loadConfig(kind);
  }

  function updateSource(source: string): void {
    const current = drafts[activeKind];
    if (!current) return;
    setDrafts({ ...drafts, [activeKind]: { ...current, source } });
  }

  function openAdvanced(): void {
    if (activeKind === "desktop") desktopSection = "advanced";
    else toolsSection = "advanced";
  }

  function reload(): void {
    if (saving) return;
    if (dirty && !window.confirm("Discard unsaved settings changes and reload this config?")) return;
    void loadConfig(activeKind, true);
  }

  async function save(): Promise<void> {
    const kind = activeKind;
    const current = drafts[kind];
    if (!current || !dirty || issues.length > 0 || saving) return;
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
      const latest = drafts[kind];
      if (!latest) return;
      setDrafts({
        ...drafts,
        [kind]: reconcileSavedSettingsDraft(latest, savedSource, result.document),
      });
    } catch (caught) {
      if (!indicatorDisposed && generation === saveGeneration) error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (!indicatorDisposed && generation === saveGeneration) saving = false;
    }
  }
</script>

<section class="grid min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] bg-sidebar text-sidebar-foreground" aria-label="Settings editor">
  <div class="flex h-9 items-end border-b border-sidebar-border bg-chrome px-1.5">
    <button
      class={[
        "h-8 cursor-pointer border-b-2 px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        activeKind === "desktop" ? "border-b-primary text-foreground" : "border-b-transparent text-muted-foreground hover:text-foreground",
      ]}
      type="button"
      onclick={() => chooseKind("desktop")}
    >Desktop</button>
    <button
      class={[
        "h-8 cursor-pointer border-b-2 px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        activeKind === "pi-tools-suite" ? "border-b-primary text-foreground" : "border-b-transparent text-muted-foreground hover:text-foreground",
      ]}
      type="button"
      onclick={() => chooseKind("pi-tools-suite")}
    >Tools Suite</button>
    <div class="ml-auto flex h-8 items-center">
      <button
        class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        title="Reload settings from disk"
        aria-label="Reload settings from disk"
        onclick={reload}
        disabled={loadingKind !== null || saving}
      ><RefreshCw class={["h-3.5 w-3.5", loadingKind === activeKind ? "animate-spin" : ""]} aria-hidden="true" /></button>
    </div>
  </div>

  <div class="border-b border-sidebar-border bg-panel px-2.5 py-2">
    <div class="flex min-w-0 items-center gap-1.5">
      <span class="text-xs font-medium text-foreground">{activeKind === "desktop" ? "Desktop settings" : "Pi Tools Suite settings"}</span>
      {#if active && !active.exists}<span class="rounded border border-border px-1 py-0.5 text-xs text-muted-foreground">new file</span>{/if}
      {#if dirty}<span class="ml-auto text-xs font-medium text-tool-warning">Unsaved</span>{/if}
    </div>
    <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={active?.path}>{active?.path ?? "Resolving config path…"}</div>
    {#if activeKind === "desktop"}
      <p class="mt-1 text-xs leading-4 text-muted-foreground">Independent Desktop profile. TUI <span class="font-mono">pix.jsonc</span> is never inherited.</p>
    {/if}
  </div>

  {#if activeKind === "desktop"}
    <SettingsSectionNav items={DESKTOP_SECTIONS} active={desktopSection} onChange={(id) => desktopSection = id as DesktopSection} />
  {:else}
    <SettingsSectionNav items={TOOLS_SECTIONS} active={toolsSection} onChange={(id) => toolsSection = id as ToolsSection} />
  {/if}

  <div class="min-h-0 overflow-y-auto">
    {#if loadingKind === activeKind && !active}
      <div class="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading settings…</div>
    {:else if error && !active}
      <div class="px-3 py-8 text-center"><TriangleAlert class="mx-auto mb-2 h-5 w-5 text-tool-error" aria-hidden="true" /><p class="text-xs font-medium text-foreground">Could not load settings</p><p class="mt-1 text-xs leading-4 text-tool-error">{error}</p></div>
    {:else if active}
      {#if parsed.errors.length > 0 && !advanced}
        <div class="m-2.5 rounded-lg border border-tool-error/25 bg-tool-error/5 p-3">
          <div class="flex items-start gap-2">
            <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0 text-tool-error" aria-hidden="true" />
            <div class="min-w-0">
              <h2 class="text-xs font-semibold text-foreground">JSONC needs repair</h2>
              <p class="mt-1 text-xs leading-4 text-muted-foreground">The structured editor is disabled until the config parses. Open Advanced to repair the source without losing comments.</p>
              <button class="mt-2 h-7 cursor-pointer rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={openAdvanced}>Open Advanced JSONC</button>
            </div>
          </div>
        </div>
      {:else if advanced}
        <div class="px-2.5 py-2.5">
          <h2 class="text-sm font-semibold text-foreground">Advanced JSONC</h2>
          <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Edit the complete source directly. This is the escape hatch for comments, free-form maps, and values not exposed by the curated controls.</p>
        </div>
        <div class="p-2 pt-0">
          <textarea
            class="min-h-[28rem] w-full resize-none rounded-md border border-code-border bg-code p-2.5 font-mono text-xs leading-4 text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
            value={active.source}
            aria-label={`${activeKind} advanced JSONC`}
            spellcheck="false"
            oninput={(event) => updateSource((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </div>
      {:else if activeKind === "desktop"}
        <DesktopSettingsEditor source={active.source} schema={active.schemaObject} models={settingsModels} section={desktopSection as Exclude<DesktopSection, "advanced">} onChange={updateSource} />
      {:else}
        <ToolsSuiteSettingsEditor source={active.source} schema={active.schemaObject} models={settingsModels} section={toolsSection as Exclude<ToolsSection, "advanced">} onChange={updateSource} />
      {/if}
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
        class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        onclick={() => void save()}
        disabled={!active || !dirty || issues.length > 0 || saving}
      >{#if saving}<RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}<Save class="h-3 w-3" aria-hidden="true" />{/if}{saving ? "Saving…" : "Save"}</button>
    </div>
  </div>
</section>
