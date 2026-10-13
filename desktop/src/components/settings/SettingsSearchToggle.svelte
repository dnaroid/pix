<script lang="ts">
  import SettingsFieldRow from "./SettingsFieldRow.svelte";
  import { readSearchSourceSelection, setSearchSourceSelection, SEARCH_SOURCE_SELECTION_CHANGED } from "../../lib/search-source-selection";
  let { cwd }: { cwd: string } = $props();
  let enabled = $state<boolean | null>(null);
  let saving = $state(false);
  let error = $state("");
  let owner: AbortController | undefined;
  $effect(() => {
    const workspace = cwd;
    const controller = new AbortController();
    owner = controller;
    let revision = 0;
    enabled = null;
    saving = false;
    const refresh = async () => {
      const current = ++revision;
      try {
        const policy = await readSearchSourceSelection(workspace, controller.signal);
        if (!controller.signal.aborted && revision === current) {
          if (policy.error) throw new Error(policy.error);
          enabled = policy.enabled.settings; error = "";
        }
      } catch (cause) { if (!controller.signal.aborted && revision === current) error = String(cause); }
    };
    void refresh();
    window.addEventListener(SEARCH_SOURCE_SELECTION_CHANGED, refresh);
    return () => { controller.abort(); window.removeEventListener(SEARCH_SOURCE_SELECTION_CHANGED, refresh); };
  });
  async function change(value: boolean) {
    const controller = owner;
    if (!controller || saving) return;
    saving = true;
    try {
      const policy = await setSearchSourceSelection(cwd, "settings", value, controller.signal);
      if (!controller.signal.aborted) { enabled = policy.enabled.settings; error = ""; }
    } catch (cause) { if (!controller.signal.aborted) error = String(cause); }
    finally { if (owner === controller) saving = false; }
  }
</script>

<SettingsFieldRow label="Search settings" description="Include the authored settings catalogue in search for all projects. Saved immediately. Disabling retains the shared cache; it does not change provider configuration.">
  <input type="checkbox" aria-label="Search settings across all projects" checked={enabled === true} disabled={enabled === null || saving} onchange={event => void change(event.currentTarget.checked)} class="h-3.5 w-3.5 accent-primary focus-visible:outline-2 focus-visible:outline-ring" />
</SettingsFieldRow>
{#if error}<p class="px-2.5 py-2 text-xs text-tool-error" role="alert">{error}</p>{/if}
