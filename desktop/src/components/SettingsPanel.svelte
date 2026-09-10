<script lang="ts">
  import Braces from "@lucide/svelte/icons/braces";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import Save from "@lucide/svelte/icons/save";
  import Search from "@lucide/svelte/icons/search";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import {
    formatSettingJson,
    formatSettingValueForList,
    formatSettingsDefaultValue,
    formatSettingsPath,
    parseSettingStringList,
    parseSettingsSchema,
    parseSettingsSource,
    removeSettingsValue,
    settingsDefaultValue,
    settingsHasValue,
    settingsEditorCache,
    settingsSections,
    settingsSourceIssues,
    settingsValue,
    updateSettingsSource,
    updateSettingsEditorCache,
    type SettingsConfigDocument,
    type SettingsConfigKind,
    type SettingsDraftDocument,
    type SettingsField,
  } from "../lib/settings";

  const initialCache = settingsEditorCache();
  let activeKind = $state<SettingsConfigKind>(initialCache.activeKind);
  let drafts = $state<Partial<Record<SettingsConfigKind, SettingsDraftDocument>>>(initialCache.drafts);
  let loadingKind = $state<SettingsConfigKind | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let query = $state("");
  let rawMode = $state(false);

  const active = $derived(drafts[activeKind]);
  const parsed = $derived(active ? parseSettingsSource(active.source) : { value: {}, errors: [] });
  const issues = $derived(active ? settingsSourceIssues(active.source, active.schemaObject) : []);
  const dirty = $derived(Boolean(active && active.source !== active.savedSource));
  const sections = $derived(active ? settingsSections(active.schemaObject) : []);
  const filteredSections = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sections;
    return sections
      .map((section) => ({
        ...section,
        fields: section.fields.filter((field) => [
          section.title,
          section.description ?? "",
          field.label,
          field.description ?? "",
          formatSettingsPath(field.path),
        ].some((part) => part.toLowerCase().includes(needle))),
      }))
      .filter((section) => section.fields.length > 0);
  });

  onMount(() => {
    void loadConfig(activeKind);
  });

  function setDrafts(next: Partial<Record<SettingsConfigKind, SettingsDraftDocument>>): void {
    drafts = next;
    updateSettingsEditorCache({ activeKind, drafts: next });
  }

  async function loadConfig(kind: SettingsConfigKind, force = false): Promise<void> {
    if (!force && drafts[kind]) return;
    loadingKind = kind;
    error = null;
    try {
      const document = await invoke<SettingsConfigDocument>("read_user_config", { kind });
      const schemaObject = parseSettingsSchema(document.schema);
      setDrafts({
        ...drafts,
        [kind]: { ...document, source: document.content, savedSource: document.content, schemaObject },
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (loadingKind === kind) loadingKind = null;
    }
  }

  function chooseKind(kind: SettingsConfigKind): void {
    activeKind = kind;
    updateSettingsEditorCache({ activeKind: kind, drafts });
    query = "";
    rawMode = false;
    error = null;
    void loadConfig(kind);
  }

  function updateSource(source: string): void {
    const current = drafts[activeKind];
    if (!current) return;
    setDrafts({ ...drafts, [activeKind]: { ...current, source } });
  }

  function setField(field: SettingsField, value: unknown): void {
    const current = drafts[activeKind];
    if (!current) return;
    updateSource(updateSettingsSource(current.source, field.path, value));
  }

  function resetField(field: SettingsField): void {
    const current = drafts[activeKind];
    if (!current) return;
    updateSource(removeSettingsValue(current.source, field.path));
  }

  function reload(): void {
    if (dirty && !window.confirm("Discard unsaved settings changes and reload this config?")) return;
    void loadConfig(activeKind, true);
  }

  async function save(): Promise<void> {
    const kind = activeKind;
    const current = drafts[kind];
    if (!current || !dirty || issues.length > 0 || saving) return;
    saving = true;
    error = null;
    try {
      const document = await invoke<SettingsConfigDocument>("write_user_config", {
        kind,
        content: current.source,
      });
      setDrafts({
        ...drafts,
        [kind]: {
          ...current,
          ...document,
          source: document.content,
          savedSource: document.content,
        },
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      saving = false;
    }
  }

  function boolValue(field: SettingsField): string {
    if (!settingsHasValue(parsed.value, field.path)) return "unset";
    return settingsValue(parsed.value, field.path) === true ? "true" : "false";
  }

  function selectValue(field: SettingsField): string {
    if (!settingsHasValue(parsed.value, field.path)) return "__unset__";
    return JSON.stringify(settingsValue(parsed.value, field.path));
  }
</script>

<section class="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-sidebar text-sidebar-foreground" aria-label="Settings editor">
  <div class="flex h-9 items-end border-b border-sidebar-border bg-chrome px-1.5">
    <button
      class={[
        "h-8 cursor-pointer border-b-2 px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        activeKind === "pix" ? "border-b-primary text-foreground" : "border-b-transparent text-muted-foreground hover:text-foreground",
      ]}
      type="button"
      onclick={() => chooseKind("pix")}
    >Pix</button>
    <button
      class={[
        "h-8 cursor-pointer border-b-2 px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        activeKind === "pi-tools-suite" ? "border-b-primary text-foreground" : "border-b-transparent text-muted-foreground hover:text-foreground",
      ]}
      type="button"
      onclick={() => chooseKind("pi-tools-suite")}
    >Tools Suite</button>
    <div class="ml-auto flex h-8 items-center gap-0.5">
      <button
        class={[
          "grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          rawMode && "bg-chrome-hover text-foreground",
        ]}
        type="button"
        title={rawMode ? "Show generated form" : "Edit raw JSONC"}
        aria-label={rawMode ? "Show generated form" : "Edit raw JSONC"}
        onclick={() => rawMode = !rawMode}
        disabled={!active}
      >{#if rawMode}<SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" />{:else}<Braces class="h-3.5 w-3.5" aria-hidden="true" />{/if}</button>
      <button
        class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        title="Reload config"
        aria-label="Reload config"
        onclick={reload}
        disabled={loadingKind !== null}
      ><RefreshCw class={["h-3.5 w-3.5", loadingKind === activeKind ? "animate-spin" : ""]} aria-hidden="true" /></button>
    </div>
  </div>

  <div class="space-y-2 border-b border-sidebar-border bg-panel px-2.5 py-2">
    <div class="min-w-0">
      <div class="flex items-center gap-1.5">
        <span class="text-[11px] font-medium text-foreground">{activeKind === "pix" ? "Pix configuration" : "Pi Tools Suite"}</span>
        {#if active && !active.exists}<span class="rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">new file</span>{/if}
        {#if dirty}<span class="ml-auto text-[10px] font-medium text-tool-warning">Unsaved</span>{/if}
      </div>
      <div class="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={active?.path}>{active?.path ?? "Resolving config path…"}</div>
    </div>
    {#if !rawMode}
      <label class="relative block">
        <span class="sr-only">Search settings</span>
        <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          class="h-7 w-full rounded-md border border-input bg-panel-strong pr-2 pl-7 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30"
          type="search"
          placeholder="Search settings…"
          bind:value={query}
          autocomplete="off"
        />
      </label>
    {/if}
  </div>

  <div class="min-h-0 overflow-y-auto">
    {#if loadingKind === activeKind && !active}
      <div class="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading settings…</div>
    {:else if error && !active}
      <div class="px-3 py-8 text-center"><TriangleAlert class="mx-auto mb-2 h-5 w-5 text-tool-error" aria-hidden="true" /><p class="text-xs font-medium text-foreground">Could not load settings</p><p class="mt-1 text-[11px] leading-4 text-tool-error">{error}</p></div>
    {:else if active && rawMode}
      <div class="h-full min-h-80 p-2">
        <textarea
          class="h-full min-h-80 w-full resize-none rounded-md border border-code-border bg-code p-2.5 font-mono text-[11px] leading-4 text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
          value={active.source}
          aria-label={`${activeKind} raw JSONC`}
          spellcheck="false"
          oninput={(event) => updateSource((event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      </div>
    {:else if active}
      {#if filteredSections.length === 0}
        <div class="px-3 py-10 text-center text-[11px] text-muted-foreground">No settings match “{query}”.</div>
      {:else}
        <div class="divide-y divide-sidebar-border">
          {#each filteredSections as section (section.id)}
            <section class="py-2" aria-label={section.title}>
              <div class="px-2.5 pb-1.5">
                <h3 class="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{section.title}</h3>
                {#if section.description}<p class="mt-0.5 text-[10px] leading-4 text-muted-foreground/80">{section.description}</p>{/if}
              </div>
              <div class="divide-y divide-sidebar-border/70 border-y border-sidebar-border/70 bg-panel">
                {#each section.fields as field (formatSettingsPath(field.path))}
                  {@const hasValue = settingsHasValue(parsed.value, field.path)}
                  {@const value = settingsValue(parsed.value, field.path)}
                  {@const defaultValue = settingsDefaultValue(activeKind, active.schemaObject, field.path)}
                  {@const effectiveValue = hasValue ? value : defaultValue.value}
                  <div class="group px-2.5 py-2 hover:bg-panel-hover/50">
                    <div class="flex min-w-0 items-start gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="flex items-baseline gap-1.5">
                          <label class="text-[11px] font-medium text-foreground" for={`setting-${formatSettingsPath(field.path)}`}>{field.label}</label>
                          {#if !hasValue}
                            <span class="text-[9px] text-muted-foreground/65">
                              {defaultValue.exists ? `default · ${formatSettingsDefaultValue(defaultValue.value)}` : "unset"}
                            </span>
                          {/if}
                        </div>
                        <div class="mt-0.5 font-mono text-[9px] text-muted-foreground/65">{formatSettingsPath(field.path)}</div>
                        {#if field.description}<p class="mt-1 text-[10px] leading-4 text-muted-foreground">{field.description}</p>{/if}
                      </div>
                      {#if hasValue}
                        <button
                          class="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
                          type="button"
                          title={defaultValue.exists ? "Reset to default value" : "Remove explicit value"}
                          aria-label={`Reset ${field.label}`}
                          onclick={() => resetField(field)}
                        ><RotateCcw class="h-3 w-3" aria-hidden="true" /></button>
                      {/if}
                    </div>

                    <div class="mt-1.5">
                      {#if field.kind === "boolean"}
                        <div class="relative">
                          <select
                            id={`setting-${formatSettingsPath(field.path)}`}
                            class={[
                              "h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong py-0 pr-7 pl-2 text-[11px] outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30",
                              hasValue ? "text-foreground" : "text-muted-foreground",
                            ]}
                            value={boolValue(field)}
                            onchange={(event) => {
                              const next = (event.currentTarget as HTMLSelectElement).value;
                              if (next === "unset") resetField(field);
                              else setField(field, next === "true");
                            }}
                          >
                            <option value="unset">{defaultValue.exists ? `${formatSettingsDefaultValue(defaultValue.value)} (Default)` : "Unset"}</option>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                          <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                        </div>
                      {:else if field.kind === "select"}
                        <div class="relative">
                          <select
                            id={`setting-${formatSettingsPath(field.path)}`}
                            class={[
                              "h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong py-0 pr-7 pl-2 text-[11px] outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30",
                              hasValue ? "text-foreground" : "text-muted-foreground",
                            ]}
                            value={selectValue(field)}
                            onchange={(event) => {
                              const next = (event.currentTarget as HTMLSelectElement).value;
                              if (next === "__unset__") resetField(field);
                              else setField(field, JSON.parse(next));
                            }}
                          >
                            <option value="__unset__">{defaultValue.exists ? `${formatSettingsDefaultValue(defaultValue.value)} (Default)` : "Unset"}</option>
                            {#each field.options ?? [] as option}
                              <option value={JSON.stringify(option.value)}>{option.label}</option>
                            {/each}
                          </select>
                          <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                        </div>
                      {:else if field.kind === "number"}
                        <input
                          id={`setting-${formatSettingsPath(field.path)}`}
                          class={[
                            "h-7 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                            hasValue ? "text-foreground" : "text-muted-foreground",
                          ]}
                          type="number"
                          value={typeof effectiveValue === "number" ? effectiveValue : ""}
                          min={field.minimum}
                          max={field.maximum}
                          step={field.integer ? 1 : "any"}
                          placeholder="Unset"
                          oninput={(event) => {
                            const raw = (event.currentTarget as HTMLInputElement).value;
                            if (raw === "") resetField(field);
                            else if (Number.isFinite(Number(raw))) setField(field, Number(raw));
                          }}
                        />
                      {:else if field.kind === "string"}
                        <input
                          id={`setting-${formatSettingsPath(field.path)}`}
                          class={[
                            "h-7 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-[11px] outline-none placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-ring/30",
                            hasValue ? "text-foreground" : "text-muted-foreground",
                          ]}
                          type={field.sensitive ? "password" : "text"}
                          value={typeof effectiveValue === "string" ? effectiveValue : ""}
                          placeholder={defaultValue.exists ? `Default: ${formatSettingsDefaultValue(defaultValue.value)}` : "Unset"}
                          autocomplete="off"
                          spellcheck="false"
                          oninput={(event) => setField(field, (event.currentTarget as HTMLInputElement).value)}
                        />
                      {:else if field.kind === "string-list"}
                        <textarea
                          id={`setting-${formatSettingsPath(field.path)}`}
                          class={[
                            "min-h-16 w-full resize-y rounded-md border border-input bg-panel-strong px-2 py-1.5 font-mono text-[10px] leading-4 outline-none placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-ring/30",
                            hasValue ? "text-foreground" : "text-muted-foreground",
                          ]}
                          value={formatSettingValueForList(effectiveValue)}
                          placeholder={defaultValue.exists ? `Default: ${formatSettingsDefaultValue(defaultValue.value)}` : "One item per line"}
                          spellcheck="false"
                          onchange={(event) => setField(field, parseSettingStringList((event.currentTarget as HTMLTextAreaElement).value))}
                        ></textarea>
                      {:else}
                        <textarea
                          id={`setting-${formatSettingsPath(field.path)}`}
                          class={[
                            "min-h-20 w-full resize-y rounded-md border border-code-border bg-code px-2 py-1.5 font-mono text-[10px] leading-4 outline-none placeholder:text-muted-foreground/65 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
                            hasValue ? "text-foreground" : "text-muted-foreground",
                          ]}
                          value={formatSettingJson(effectiveValue)}
                          placeholder={defaultValue.exists ? `Default: ${formatSettingsDefaultValue(defaultValue.value)}` : "Structured JSON value"}
                          spellcheck="false"
                          onchange={(event) => {
                            const target = event.currentTarget as HTMLTextAreaElement;
                            const raw = target.value.trim();
                            if (!raw) {
                              target.setCustomValidity("");
                              resetField(field);
                              return;
                            }
                            try {
                              setField(field, JSON.parse(raw));
                              target.setCustomValidity("");
                            } catch {
                              target.setCustomValidity("Enter valid JSON, or use raw JSONC mode for comments.");
                              target.reportValidity();
                            }
                          }}
                        ></textarea>
                        <div class="mt-1 text-[9px] text-muted-foreground/65">Structured fallback · use raw JSONC mode to preserve comments inside this value.</div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  <div class="border-t border-sidebar-border bg-chrome px-2.5 py-2">
    {#if error}
      <div class="mb-2 rounded-md border border-tool-error/25 bg-tool-error/5 px-2 py-1.5 text-[10px] leading-4 text-tool-error">{error}</div>
    {/if}
    {#if active && issues.length > 0}
      <div class="mb-2 flex items-start gap-1.5 text-[10px] leading-4 text-tool-error"><TriangleAlert class="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /><span>{issues[0]}{issues.length > 1 ? ` · ${issues.length - 1} more` : ""}</span></div>
    {/if}
    <div class="flex items-center gap-2">
      <span class="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">Changes may require a new or reloaded session.</span>
      <button
        class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        onclick={() => void save()}
        disabled={!active || !dirty || issues.length > 0 || saving}
      >{#if saving}<RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}<Save class="h-3 w-3" aria-hidden="true" />{/if}{saving ? "Saving…" : "Save"}</button>
    </div>
  </div>
</section>
