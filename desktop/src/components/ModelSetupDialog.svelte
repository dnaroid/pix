<script lang="ts">
  import { dialogCancelButtonClass, dialogPrimaryButtonClass, modalBackdropClass } from "../lib/dialog";
  import { activateModalDialog } from "../lib/modal-dialog";
  import type { ModelSetupRoles, ModelSetupSearch, ModelSetupSlot, ModelSetupStatus } from "../lib/acp-pix-extensions";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import X from "@lucide/svelte/icons/x";
  import SettingsTextInput from "./settings/SettingsTextInput.svelte";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  import SettingsSwitch from "./settings/SettingsSwitch.svelte";
  import SettingsModelSelect from "./settings/SettingsModelSelect.svelte";
  import { modelSetupRequest, notifyUserConfigWritten } from "../lib/model-setup-request.svelte";
  import { modelSetupOverrides } from "../lib/model-setup-overrides";
  import { modelUsage, promoteFrontier, replaceModel, upgradeCandidate, type SetupDraft, type UsageSlot } from "../lib/model-setup-replace";

  const DISMISSED_KEY = "pix.desktop.model-setup.v1.dismissed";

  type SetupClient = {
    modelSetupStatus(): Promise<ModelSetupStatus>;
    applyModelSetup(roles: ModelSetupRoles, overrides?: Readonly<Record<string, string | readonly string[]>>, search?: ModelSetupSearch): Promise<void>;
  };

  let { client, onApplied, catalog = [] }: { client: SetupClient | undefined; onApplied?: () => void | Promise<void>; catalog?: readonly { ref: string; name: string; modelId: string; thinkingLevels?: readonly string[] }[] } = $props();

  let dialogElement = $state<HTMLDialogElement | null>(null);
  let saveButton = $state<HTMLButtonElement | null>(null);
  let status = $state<ModelSetupStatus | null>(null);
  let visible = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let roles = $state<ModelSetupRoles>({ main: "", fast: "", strong: "" });
  let checkedClient: SetupClient | undefined;

  const toOption = (m: { ref: string; label: string }) => ({ value: m.ref, label: m.label, description: m.ref, aliases: [m.ref], keywords: [m.label] });
  // Configured refs missing from the available list stay selectable, shown by bare model id.
  const extraModels = $derived.by(() => {
    const known = new Set([...(status?.models ?? []).map((m) => m.ref), ...catalog.map((m) => m.ref)]);
    const refs = new Set([...Object.values(roles), ...Object.values(slotPicks), ...Object.values(status?.currentSlots ?? {}), ...Object.values(status?.currentLists ?? {}).flat(), ...Object.values(slotLists).flat()].filter((ref) => ref && !known.has(ref)));
    return [...refs].map((ref) => ({ ref, label: ref.slice(ref.indexOf("/") + 1), vision: true }));
  });
  // Union of the setup list and Desktop's live catalog (includes extension providers).
  const allModels = $derived.by(() => {
    const base = [...(status?.models ?? [])];
    const seen = new Set(base.map((m) => m.ref));
    for (const m of catalog) if (!seen.has(m.ref)) { seen.add(m.ref); base.push({ ref: m.ref, label: m.name.trim() || m.modelId, vision: true }); }
    return [...base, ...extraModels.filter((m) => !seen.has(m.ref))];
  });
  const options = $derived(allModels.map(toOption));
  const visionOptions = $derived(allModels.filter((m) => m.vision).map(toOption));
  const slotOptions = (slot: { id?: string; vision?: boolean; openrouter?: boolean }) => (slot.vision ? visionOptions : options)
    .filter((o) => (!slot.openrouter || o.value.startsWith("openrouter/"))
      && (!slot.id?.startsWith("knowledge-judge") || (o.value.length <= 256 && /^[^\s/:]+\/[^\s:]+$/u.test(o.value))));
  let searchOn = $state(false);
  let searchProvider = $state<"openrouter" | "ollama">("openrouter");
  let searchModel = $state("");
  let searchVector = $state("1536");
  let searchKnowledge = $state("");
  let searchReranker = $state("");
  const searchValid = $derived(!searchOn || (searchModel.trim().length > 0 && Number.isInteger(Number(searchVector)) && Number(searchVector) > 0));
  // Per-slot picks that differ from the role default; untouched slots follow their role.
  let slotPicks = $state<Record<string, string>>({});
  // Ordered fallback chains and thinking levels, keyed by slot id; absent = untouched.
  let slotLists = $state<Record<string, string[]>>({});
  let slotThinking = $state<Record<string, string>>({});
  const THINKING_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, label: v === "" ? "Default" : v }));
  const thinkingOptions = (slot: ModelSetupSlot) => THINKING_OPTIONS.map(option =>
    option.value === "" && slot.thinkingDefaultLabel ? { ...option, label: slot.thinkingDefaultLabel } : option);
  const labelOf = (ref: string) => allModels.find((m) => m.ref === ref)?.label ?? ref.slice(ref.indexOf("/") + 1);
  const ordered = (slots: readonly ModelSetupSlot[]): ModelSetupSlot[] => {
    const top = slots.filter((s) => !s.parent);
    const kids = slots.filter((s) => s.parent);
    return [...top.flatMap((s) => [s, ...kids.filter((k) => k.parent === s.id)]), ...kids.filter((k) => !top.some((t) => t.id === k.parent))];
  };
  const isFallbackList = (slot: ModelSetupSlot) => /fallback/i.test(slot.label);
  const listOf = (id: string): string[] => slotLists[id] ?? status?.currentLists[id]?.slice() ?? [];
  const primaryOf = (slot: ModelSetupSlot): string => {
    const parent = slot.parent ? status?.slots.find((s) => s.id === slot.parent) : undefined;
    return parent ? slotValue(parent) : "";
  };
  const addFallbackOptions = (slot: ModelSetupSlot) => {
    const taken = new Set([primaryOf(slot), ...listOf(slot.id)]);
    return slotOptions(slot).filter((o) => !taken.has(o.value));
  };
  const addFallback = (slot: ModelSetupSlot, ref: string) => {
    if (!ref || ref === primaryOf(slot) || listOf(slot.id).includes(ref)) return;
    slotLists = { ...slotLists, [slot.id]: [...listOf(slot.id), ref] };
  };
  const removeFallback = (id: string, ref: string) => { slotLists = { ...slotLists, [id]: listOf(id).filter((r) => r !== ref) }; };
  let showSlots = $state(false);
  let manual = $state(false);
  let step = $state(0);
  const PAGES: readonly (readonly [string, readonly string[]])[] = [
    ["Features", ["Sessions", "Assistant", "Git"]],
    ["Routing & desktop", ["Routing", "Desktop"]],
    ["Agents", ["Frontier", "Sub-agents", "Context", "Vision"]],
  ];
  const shortLabel = (label: string) => label.replace(/^Routing tier: /, "").replace(/^Sub-agent: /, "").replace(/^Contradiction judge \(Desktop override\)$/, "Desktop override").replace(/^Frontier model \((\w+)\)$/, (_, w: string) => w[0]!.toUpperCase() + w.slice(1));
  const pages = $derived.by(() => {
    const known = new Set(PAGES.flatMap(([, g]) => g));
    const out = PAGES.map(([title, names]) => ({ title, groups: groups.filter(([g]) => names.includes(g)) })).filter((p) => p.groups.length > 0);
    const rest = groups.filter(([g]) => !known.has(g));
    if (rest.length > 0) out.push({ title: "Other", groups: rest });
    return out;
  });
  const stepTitles = $derived([manual ? "In use" : "Roles", ...pages.map((p) => p.title), "Search"]);
  const lastStep = $derived(stepTitles.length - 1);
  const groups = $derived.by(() => {
    const map = new Map<string, NonNullable<ModelSetupStatus["slots"]>[number][]>();
    for (const slot of status?.slots ?? []) map.set(slot.group, [...(map.get(slot.group) ?? []), slot]);
    return [...map.entries()];
  });
  const slotValue = (slot: { id: string; role: keyof ModelSetupRoles; optional?: boolean }): string => slotPicks[slot.id] ?? (slot.optional ? "" : roles[slot.role]);
  // "In use" page: replace one model everywhere it is configured.
  let replaceNotes = $state<string[]>([]);
  const draft = $derived<SetupDraft>({
    roles,
    picks: slotPicks,
    lists: Object.fromEntries((status?.slots ?? []).filter((s) => s.list).map((s) => [s.id, listOf(s.id)])),
    thinking: slotThinking,
  });
  const usage = $derived(modelUsage(status?.slots ?? [], draft));
  const fits = (slot: UsageSlot, ref: string) => slotOptions(slot as ModelSetupSlot).some((o) => o.value === ref);
  const levelsOf = (ref: string) => catalog.find((m) => m.ref === ref)?.thinkingLevels;
  const upgradeOf = (ref: string) => upgradeCandidate(ref, allModels.map((m) => m.ref));
  const usageText = (slots: readonly UsageSlot[]) => {
    const names = [...new Set(slots.map((s) => shortLabel(s.label)))];
    return `${slots.length} ${slots.length === 1 ? "place" : "places"}: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` +${names.length - 4}` : ""}`;
  };
  function applyDraft(next: SetupDraft): void {
    roles = { ...next.roles };
    slotPicks = { ...next.picks };
    slotLists = Object.fromEntries(Object.entries(next.lists).map(([id, l]) => [id, [...l]]));
    slotThinking = { ...next.thinking };
  }
  function replaceEverywhere(from: string, to: string): void {
    if (!to || to === from) return;
    const result = replaceModel(status?.slots ?? [], draft, from, to, { fits, levelsOf, labelOf: (slot) => shortLabel(slot.label) });
    applyDraft(result.draft);
    replaceNotes = [`${labelOf(from)} → ${labelOf(to)}`, ...result.notes.map((n) => `  ${n}`)];
  }
  function addFrontierRelease(ref: string): void {
    if (!ref) return;
    applyDraft(promoteFrontier(status?.slots ?? [], draft, ref));
    replaceNotes = [`${labelOf(ref)} is now the primary frontier model; the previous one stays in the frontier list.`];
  }
  const complete = $derived(Boolean(roles.main && roles.fast && roles.strong) && searchValid);

  $effect(() => {
    if (!visible || !dialogElement) return;
    return activateModalDialog(dialogElement, () => saveButton);
  });

  $effect(() => {
    const current = client;
    if (!current || current === checkedClient) return;
    checkedClient = current;
    if (localStorage.getItem(DISMISSED_KEY) === "1") return;
    let cancelled = false;
    void current.modelSetupStatus().then((next) => {
      if (cancelled || checkedClient !== current) return;
      if (next.configured || next.models.length === 0) return;
      status = next;
      roles = next.suggested ?? { main: "", fast: "", strong: "" };
      // A first-run default model may be absent even when an explicit judge is already set.
      slotPicks = Object.fromEntries(Object.entries(next.currentSlots).filter(([id]) => next.slots.some(slot => slot.id === id && slot.optional && !slot.list)));
      slotLists = {};
      slotThinking = { ...next.currentThinking };
      showSlots = false;
      step = 0;
      visible = true;
    }).catch(() => undefined);
    return () => { cancelled = true; };
  });

  let handledRequests = modelSetupRequest.count;

  $effect(() => {
    const count = modelSetupRequest.count;
    const current = client;
    if (count === handledRequests || !current) return;
    handledRequests = count;
    let cancelled = false;
    error = null;
    void current.modelSetupStatus().then((next) => {
      if (cancelled || next.models.length === 0) return;
      status = next;
      roles = next.current ?? next.suggested ?? { main: "", fast: "", strong: "" };
      slotPicks = Object.fromEntries(Object.entries(next.currentSlots).filter(([id, ref]) => {
        const slot = next.slots.find((s) => s.id === id);
        return slot !== undefined && !slot.list && (slot.optional ? ref !== "" : ref !== roles[slot.role]);
      }));
      slotLists = Object.fromEntries(Object.entries(next.currentLists).map(([id, l]) => [id, [...l]]));
      slotThinking = { ...next.currentThinking };
      const cs = next.currentSearch;
      searchOn = cs !== undefined;
      if (cs) {
        searchProvider = cs.provider; searchModel = cs.model; searchVector = String(cs.vectorSize);
        searchKnowledge = cs.knowledgeModel ?? ""; searchReranker = cs.reranker ?? "";
      }
      showSlots = true;
      replaceNotes = [];
      manual = true;
      step = 0;
      visible = true;
    }).catch((cause) => { error = cause instanceof Error ? cause.message : String(cause); });
    return () => { cancelled = true; };
  });

  async function save(): Promise<void> {
    if (!client || saving || !complete) return;
    saving = true;
    error = null;
    try {
      await client.applyModelSetup(roles, modelSetupOverrides(status?.slots ?? [], slotPicks, slotLists, slotThinking), searchOn ? {
        provider: searchProvider, model: searchModel.trim(), vectorSize: Number(searchVector),
        ...(searchKnowledge.trim() ? { knowledgeModel: searchKnowledge.trim() } : {}),
        reranker: searchReranker.trim(),
      } : undefined);
      visible = false;
      manual = false;
      notifyUserConfigWritten();
      await onApplied?.();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  }

  function skip(): void {
    if (!manual) localStorage.setItem(DISMISSED_KEY, "1");
    manual = false;
    visible = false;
  }

  const rows: readonly { key: keyof ModelSetupRoles; title: string; hint: string }[] = [
    { key: "main", title: "Main", hint: "Everyday coding and default model" },
    { key: "fast", title: "Fast", hint: "Autocomplete, titles, commit messages, research agents" },
    { key: "strong", title: "Strong", hint: "Reviews and frontier sub-agents" },
  ];
</script>

{#if visible}
  <dialog bind:this={dialogElement} class={modalBackdropClass} aria-labelledby="model-setup-title" oncancel={(e) => { e.preventDefault(); skip(); }}>
    <div class="flex max-h-[calc(100vh-48px)] w-[600px] max-w-[calc(100vw-40px)] flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
      <header class="shrink-0 border-b border-border px-5 pt-4 pb-3">
        <div class="flex items-baseline justify-between gap-3">
          <h2 id="model-setup-title" class="text-sm font-semibold text-foreground">{manual ? "Models" : "Set up models"}</h2>
          <span class="text-xs text-muted-foreground">Step {step + 1} of {stepTitles.length}</span>
        </div>
        <nav class="mt-3 flex gap-1" aria-label="Setup steps">
          {#each stepTitles as title, i (i)}
            <button
              type="button"
              class={["flex-1 truncate rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default",
                i === step ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-panel-hover hover:text-foreground"]}
              aria-current={i === step ? "step" : undefined}
              disabled={i > 0 && !(roles.main && roles.fast && roles.strong)}
              onclick={() => { step = i; }}
            >{title}</button>
          {/each}
        </nav>
      </header>

      <div class="min-h-[320px] flex-1 overflow-y-auto px-5 py-4">
        {#if step === 0 && manual}
          <p class="mb-4 text-xs leading-5 text-muted-foreground">Every model currently configured. Replacing one updates every place it is used: features, routing tiers, agents, fallback lists and the frontier list. Unsupported thinking levels move to the nearest supported one. Nothing is written until you save.</p>
          <div class="grid grid-cols-[minmax(0,1fr)_240px] items-center gap-x-4 gap-y-2.5">
            {#each usage as entry (entry.ref)}
              {@const upgrade = upgradeOf(entry.ref)}
              <div class="min-w-0">
                <div class="truncate text-xs font-medium text-foreground" title={entry.ref}>{labelOf(entry.ref)}</div>
                <div class="truncate text-xs text-muted-foreground" title={entry.slots.map((s) => s.label).join(", ")}>{usageText(entry.slots)}</div>
                {#if upgrade}
                  <button type="button" class="mt-0.5 text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring" onclick={() => replaceEverywhere(entry.ref, upgrade)}>Newer: {labelOf(upgrade)} — replace</button>
                {/if}
              </div>
              <SettingsModelSelect value={entry.ref} {options} popup ariaLabel={`Replace ${labelOf(entry.ref)} everywhere`} onChange={(value) => replaceEverywhere(entry.ref, value)} />
            {/each}
            <div class="col-span-2 mt-2 border-t border-border pt-3"></div>
            <div class="min-w-0">
              <div class="text-xs font-medium text-foreground">New frontier release</div>
              <div class="truncate text-xs text-muted-foreground">Becomes the primary frontier model; current ones stay in the list.</div>
            </div>
            <SettingsModelSelect value="" {options} popup addTrigger emptyLabel="Frontier model" ariaLabel="Add new frontier model" onChange={addFrontierRelease} />
          </div>
          {#if replaceNotes.length > 0}
            <div class="mt-4 rounded-md border border-border bg-panel-strong px-3 py-2 text-xs leading-4 whitespace-pre-wrap text-muted-foreground" role="status">{replaceNotes.join("\n")}</div>
          {/if}
          <p class="mt-4 text-xs leading-4 text-muted-foreground">Use Next for per-feature models, fallbacks and thinking levels.</p>
        {:else if step === 0}
          <p class="mb-4 text-xs leading-5 text-muted-foreground">Pick three models from your connected providers. Every feature on the next steps defaults to one of these roles.</p>
          <div class="grid grid-cols-[minmax(0,1fr)_280px] items-center gap-x-4 gap-y-3">
            {#each rows as row (row.key)}
              <div class="min-w-0">
                <div class="text-xs font-medium text-foreground">{row.title}</div>
                <div class="truncate text-xs text-muted-foreground">{row.hint}</div>
              </div>
              <SettingsModelSelect
                value={roles[row.key]}
                {options}
                popup
                ariaLabel={`${row.title} model`}
                onChange={(value) => { roles = { ...roles, [row.key]: value }; slotPicks = Object.fromEntries(Object.entries(slotPicks).filter(([id]) => { const s = status?.slots.find((x) => x.id === id); return s?.optional || s?.role !== row.key; })); }}
              />
            {/each}
          </div>
        {:else if step < lastStep}
          <div class="grid grid-cols-[150px_minmax(0,1fr)_96px] items-center gap-x-2 gap-y-1.5">
            <span></span>
            <span class="px-1 text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">Model</span>
            <span class="px-1 text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">Thinking</span>
            {#each pages[step - 1]?.groups ?? [] as [group, slots], gi (group)}
              <div class={["col-span-3 text-xs font-semibold text-foreground", gi > 0 ? "mt-3 border-t border-border pt-3" : "mt-1"]}>{group}</div>
              {#each ordered(slots) as slot (slot.id)}
                {#if slot.list}
                  <span class="truncate pl-3 text-xs text-muted-foreground">{isFallbackList(slot) ? "Fallbacks" : "Also frontier"}</span>
                  <div class="col-span-2 flex min-h-7 flex-wrap items-center gap-1">
                    {#each listOf(slot.id) as ref (ref)}
                      <span class="inline-flex h-6 items-center gap-1 rounded-md bg-panel-strong pr-1 pl-2 text-xs text-foreground">
                        {labelOf(ref)}
                        <button type="button" class="grid h-4 w-4 place-items-center rounded text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Remove ${labelOf(ref)} from ${slot.label}`} onclick={() => removeFallback(slot.id, ref)}><X class="h-3 w-3" aria-hidden="true" /></button>
                      </span>
                    {/each}
                    <SettingsModelSelect value="" options={addFallbackOptions(slot)} popup addTrigger emptyLabel={isFallbackList(slot) ? "Fallback" : "Model"} ariaLabel={`Add ${slot.label}`} onChange={(value) => addFallback(slot, value)} />
                  </div>
                {:else}
                  <span class="truncate text-xs text-foreground" title={slot.label}>{shortLabel(slot.label)}</span>
                  <SettingsModelSelect
                    value={slotValue(slot)}
                    options={slotOptions(slot)}
                    popup
                    emptyLabel={slot.optional ? slot.emptyLabel ?? "None" : undefined}
                    ariaLabel={slot.label}
                    onChange={(value) => { slotPicks = { ...slotPicks, [slot.id]: value }; }}
                  />
                  {#if slot.thinking}
                    <TaskFieldSelect value={slotThinking[slot.id] ?? ""} ariaLabel={`${slot.label} thinking`} size="sm" options={thinkingOptions(slot)} onChange={(v) => { slotThinking = { ...slotThinking, [slot.id]: v }; }} />
                  {:else}
                    <span class="px-1 text-xs text-muted-foreground/60">—</span>
                  {/if}
                {/if}
              {/each}
            {/each}
          </div>
        {:else}
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="text-xs font-medium text-foreground">Search &amp; embeddings</div>
              <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Optional. Enabling sends project code and knowledge text to the embedding provider; charges may apply.</p>
            </div>
            <SettingsSwitch value={searchOn} onChange={(v) => { searchOn = v; }} />
          </div>
          {#if searchOn}
            <div class="mt-4 grid grid-cols-[150px_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
              <span class="text-xs">Provider</span>
              <TaskFieldSelect value={searchProvider} ariaLabel="Embedding provider" size="sm" options={[{ value: "openrouter", label: "OpenRouter" }, { value: "ollama", label: "Ollama" }]} onChange={(v) => { searchProvider = v === "ollama" ? "ollama" : "openrouter"; }} />
              <span class="text-xs">Embedding model</span>
              <SettingsTextInput value={searchModel} placeholder="e.g. openai/text-embedding-3-small" onChange={(v) => { searchModel = v; }} />
              <span class="text-xs">Vector size</span>
              <SettingsTextInput value={searchVector} placeholder="1536" onChange={(v) => { searchVector = v; }} />
              <span class="text-xs">Knowledge model</span>
              <SettingsTextInput value={searchKnowledge} placeholder="Optional" onChange={(v) => { searchKnowledge = v; }} />
              <span class="text-xs">Reranker</span>
              <SettingsTextInput value={searchReranker} placeholder="Optional, e.g. voyageai/rerank-3-lite" onChange={(v) => { searchReranker = v; }} />
            </div>
          {/if}
        {/if}
        {#if error}<p class="mt-3 rounded-md border border-tool-error/30 bg-tool-error/5 px-3 py-2 text-xs leading-4 text-tool-error">{error}</p>{/if}
      </div>

      <footer class="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-border px-5">
        <button class={dialogCancelButtonClass} type="button" onclick={skip}>{manual ? "Cancel" : "Skip"}</button>
        <div class="flex items-center gap-2">
          {#if step > 0}
            <button class={dialogCancelButtonClass} type="button" onclick={() => { step -= 1; }}>Back</button>
          {/if}
          {#if step < lastStep}
            {#if manual}
              <button class="h-8 rounded-md border border-border px-3 text-xs font-medium hover:bg-panel-hover disabled:opacity-40" type="button" disabled={!complete || saving} onclick={() => void save()}>Save</button>
            {/if}
            <button bind:this={saveButton} class={dialogPrimaryButtonClass} type="button" disabled={step === 0 && !(roles.main && roles.fast && roles.strong)} onclick={() => { step += 1; }}>Next <ChevronRight class="h-3.5 w-3.5" aria-hidden="true" /></button>
          {:else}
            <button bind:this={saveButton} class={dialogPrimaryButtonClass} type="button" disabled={!complete || saving} onclick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
          {/if}
        </div>
      </footer>
    </div>
  </dialog>
{/if}
