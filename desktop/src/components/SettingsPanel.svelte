<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import X from "@lucide/svelte/icons/x";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import type { SettingsConfigKind } from "../lib/settings";
  import { settingsViewport } from "../lib/settings-viewport";
  import { tick } from "svelte";
  import { SETTINGS_GROUPS } from "../lib/settings-navigation";
  import { SETTINGS_SEARCH_CATALOG } from "../lib/settings-search-catalog";
  import { previewInlineSearch, queryInlineSearch } from "../lib/inline-search";
  import { pendingSearchNotice } from "../lib/search-source-deadline";
  import type { SettingsSearchHit } from "../../../acp/src/search/contract";
  import type { AcpClient } from "../lib/acp-client";
  import SettingsConfigEditor from "./settings/SettingsConfigEditor.svelte";
  import SettingsSectionNav from "./settings/SettingsSectionNav.svelte";

  let { configOptions, onOpenUserConfig, onIndicatorChange, workspace = "", searchClient }: {
    configOptions: readonly SessionConfigOption[];
    onOpenUserConfig: (kind: SettingsConfigKind) => void;
    onIndicatorChange?: (error: string | null) => void;
    workspace?: string;
    searchClient?: Pick<AcpClient, "searchConfig" | "searchQuery">;
  } = $props();
  let query = $state("");
  let submittedHits = $state<SettingsSearchHit[] | null>(null);
  let searching = $state(false);
  let searchNotice = $state("");
  let searchRequest: AbortController | null = null;
  const matchedFields = $derived(query.trim()
    ? new Set((submittedHits ?? previewInlineSearch("settings", query)).map(hit => `${hit.section}/${hit.fieldId}`))
    : null);
  let visible = $state<string[]>([]);
  let active = $state("");
  let viewport: HTMLDivElement;
  let searchInput: HTMLInputElement;
  let errors = $state<Partial<Record<SettingsConfigKind, string | null>>>({});
  let requestedSection: string | null = null;
  let requestedField: { section: string; fieldId: string } | null = null;

  function cancelSearch() {
    searchRequest?.abort();
    searchRequest = null;
    submittedHits = null;
    searching = false;
    searchNotice = "";
  }

  async function submitSearch() {
    const submitted = query.trim();
    if (!submitted) return;
    cancelSearch();
    if (!searchClient || !workspace) {
      searchNotice = "Offline: showing local matches";
      return;
    }
    const request = new AbortController();
    searchRequest = request;
    searching = true;
    const publish = (result: Awaited<ReturnType<typeof queryInlineSearch>>) => {
      if (searchRequest !== request || request.signal.aborted || query.trim() !== submitted) return;
      // Other sources can finish before ACP; keep local preview until useful data arrives.
      if (!result.status && !result.results.length && !result.notices.length && !result.pendingSources?.length) return;
      submittedHits = result.pendingSources?.length && !result.results.length ? null
        : result.results.filter((hit): hit is SettingsSearchHit => hit.kind === "settings");
      searching = Boolean(result.pendingSources?.length);
      searchNotice = result.notices.find(notice => !(result.pendingSources ?? []).some(source => notice === pendingSearchNotice(source)))
        ?? result.status?.warning ?? result.status?.error ?? "";
    };
    try { publish(await queryInlineSearch("settings", searchClient, workspace, submitted, request.signal, publish)); }
    catch {
      if (searchRequest === request && !request.signal.aborted) {
        searching = false;
        searchNotice = "Indexed search unavailable; showing local matches";
      }
    }
  }

  let previousWorkspace: string | undefined;
  $effect(() => {
    const currentWorkspace = workspace;
    const currentClient = searchClient;
    if (previousWorkspace !== undefined && previousWorkspace !== currentWorkspace) query = "";
    previousWorkspace = currentWorkspace;
    void currentClient;
    return cancelSearch;
  });

  function reportError(kind: SettingsConfigKind, error: string | null) {
    errors = { ...errors, [kind]: error };
    onIndicatorChange?.(errors.desktop ?? errors["pi-tools-suite"] ?? null);
  }
  function updateNavigation(next: string[], current: string) {
    if (visible.join("|") !== next.join("|")) visible = next;
    if (active !== current) active = current;
    // The target may be mounted only after asynchronous config loading completes.
    if (requestedField && next.includes(requestedField.section) && navigateField(requestedField.section, requestedField.fieldId)) requestedField = null;
    if (requestedSection && next.includes(requestedSection) && navigate(requestedSection, true)) requestedSection = null;
  }
  function navigate(id: string, focus = false): boolean {
    const section = viewport.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
    if (!section || section.hidden) return false;
    const header = section.closest("[data-settings-config]")?.querySelector("header");
    const offset = header?.getBoundingClientRect().height ?? 0;
    viewport.scrollTo({ top: viewport.scrollTop + section.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset });
    active = id;
    if (focus) {
      const heading = section.querySelector<HTMLElement>("h2") ?? section;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    return true;
  }

  function navigateField(sectionId: string, fieldId: string): boolean {
    const section = [...viewport.querySelectorAll<HTMLElement>("[data-settings-section]")]
      .find((candidate) => candidate.dataset.settingsSection === sectionId);
    const row = [...(section?.querySelectorAll<HTMLElement>("[data-settings-field-id]") ?? [])]
      .find((candidate) => candidate.dataset.settingsFieldId === fieldId);
    if (!section || section.hidden || !row || row.hidden) return false;
    const header = section.closest("[data-settings-config]")?.querySelector("header");
    const offset = header?.getBoundingClientRect().height ?? 0;
    viewport.scrollTo({ top: viewport.scrollTop + row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset - 8 });
    const control = row.querySelector<HTMLElement>("input:not([type=hidden]), button, select, textarea, [tabindex]:not([tabindex='-1'])");
    if (!control) row.tabIndex = -1;
    (control ?? row).focus({ preventScroll: true });
    active = sectionId;
    return true;
  }

  /** Used by scoped Desktop chrome deep links; no document-wide settings lookup. */
  export async function openSection(id: string): Promise<void> {
    const valid = Object.entries(SETTINGS_GROUPS).some(([kind, group]) => group.sections.some((section) => `${kind}-${section.id}` === id));
    if (!valid) return;
    requestedSection = id;
    query = "";
    cancelSearch();
    await tick();
    if (requestedSection === id && navigate(id, true)) requestedSection = null;
  }

  /** Focus one authored field row after its configuration editor has mounted. */
  export async function openField(section: string, fieldId: string): Promise<void> {
    if (!SETTINGS_SEARCH_CATALOG.some((entry) => entry.section === section && entry.id === fieldId)) return;
    requestedSection = null;
    requestedField = { section, fieldId };
    query = "";
    cancelSearch();
    await tick();
    if (requestedField?.section === section && requestedField.fieldId === fieldId && navigateField(section, fieldId)) requestedField = null;
  }
</script>

<section aria-label="Settings editor" class="grid min-h-0 grid-cols-[116px_minmax(0,1fr)] bg-sidebar text-sidebar-foreground">
  <aside class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-sidebar-border">
    <div class="relative m-1.5">
      <button type="button" aria-label="Search settings including indexed matches" title="Search settings (Enter)" onclick={() => void submitSearch()} disabled={!query.trim() || searching} class="absolute top-1 left-0.5 grid h-5 w-5 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60">{#if searching}<LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}<Search class="h-3 w-3" aria-hidden="true" />{/if}</button>
      <input bind:this={searchInput} bind:value={query} oninput={cancelSearch} onkeydown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void submitSearch(); } }} type="search" aria-label="Search settings" placeholder="Search…" class="h-7 w-full min-w-0 rounded-md border border-input bg-panel-strong pr-6 pl-6 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
      {#if query}<button type="button" aria-label="Clear settings search" onclick={() => { query = ""; cancelSearch(); searchInput.focus(); }} class="absolute top-1 right-0.5 grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring"><X class="h-3 w-3" aria-hidden="true" /></button>{/if}
    </div>
    {#if searching}<p role="status" class="px-2 pb-1 text-xs text-muted-foreground">Searching…</p>{:else if searchNotice}<p role="status" class="px-2 pb-1 text-xs leading-4 text-muted-foreground" title={searchNotice}>{searchNotice}</p>{/if}
    <SettingsSectionNav {visible} {active} onChange={navigate} />
  </aside>
  <div bind:this={viewport} use:settingsViewport={{ query, matches: matchedFields, onChange: updateNavigation }} class="min-h-0 min-w-0 overflow-y-auto">
    {#if query.trim() && visible.length === 0}<p role="status" class="px-3 py-4 text-xs text-muted-foreground">No settings found.</p>{/if}
    {#each ["desktop", "pi-tools-suite"] as kind (kind)}
      <SettingsConfigEditor kind={kind as SettingsConfigKind} {configOptions} {onOpenUserConfig} {workspace} {searchClient} onIndicatorChange={(error) => reportError(kind as SettingsConfigKind, error)} />
    {/each}
  </div>
</section>
