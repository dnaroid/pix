<script lang="ts">
  import { parseSettingsSource, settingsValue, updateSettingsSource, removeSettingsValue } from "../../lib/settings";
  import TaskFieldSelect from "../TaskFieldSelect.svelte";
  import SettingsFieldRow from "./SettingsFieldRow.svelte";
  import SettingsNumberInput from "./SettingsNumberInput.svelte";
  import SearchExtensionSettings from "./SearchExtensionSettings.svelte";

  let { source, onChange }: { source: string; onChange: (source: string) => void } = $props();
  const parsed = $derived(parseSettingsSource(source).value);
  const embedding = $derived(settingsValue(parsed, ["search", "embedding"]));
  const provider = $derived(text("embeddingProvider"));
  const dimension = $derived(settingsValue(parsed, ["search", "embedding", "vectorSize"]));
  const reranker = $derived(settingsValue(parsed, ["search", "rerankerModel"]));
  const providers = [
    { value: "", label: "Not configured" },
    { value: "openrouter", label: "OpenRouter" },
    { value: "ollama", label: "Ollama" },
  ];
  function text(key: string): string {
    const value = settingsValue(parsed, ["search", "embedding", key]);
    return typeof value === "string" ? value : "";
  }
  function set(key: string, value: unknown) {
    const path = ["search", "embedding", key];
    onChange(value === undefined ? removeSettingsValue(source, path) : updateSettingsSource(source, path, value));
  }
  function selectProvider(value: string) {
    if (!value) onChange(removeSettingsValue(source, ["search", "embedding"]));
    else set("embeddingProvider", value);
  }
  function setReranker(value: string) {
    const path = ["search", "rerankerModel"];
    onChange(value.trim() ? updateSettingsSource(source, path, value.trim()) : removeSettingsValue(source, path));
  }
</script>

<SearchExtensionSettings {source} {onChange} />
<div class="px-2.5 py-2.5">
  <h2 class="text-sm font-semibold text-foreground">Semantic search</h2>
  <p class="mt-1 text-xs leading-4 text-muted-foreground">This edits <code>~/.config/pi/pi-tools-suite.jsonc</code> at <code>search.embedding</code>. Use Save above. One valid saved configuration enables semantic search across all sources, projects, Pi and Desktop. Saving can upload eligible code/document chunks, paths/headings, task titles/descriptions, saved session names, commit metadata, settings metadata and search queries; charges may apply. Public user/assistant message text on saved session branches is automatically indexed and may be uploaded, including existing history. Tool results, thinking blocks and attachments are excluded. Local search remains available. Removing configuration stops new embedding work but retains existing vectors.</p>
  <p class="mt-1 text-xs leading-4 text-muted-foreground">After changing models, incompatible history vectors can be discarded with <code>/search-semantic reset-history</code> in the affected project. The next semantic search rebuilds them and may incur charges; tasks, sessions and Git history are preserved.</p>
</div>
<SettingsFieldRow label="Embedding provider" description="Choose Not configured to remove the provider configuration when you save.">
  <TaskFieldSelect value={provider} options={providers} onChange={selectProvider} ariaLabel="Embedding provider" compact />
</SettingsFieldRow>
<SettingsFieldRow label="Embedding model" description="Provider model identifier. Credentials use OPENROUTER_API_KEY or shared Pi auth.">
  <input aria-label="Embedding model" value={text("embeddingModel")} oninput={(event) => set("embeddingModel", event.currentTarget.value)} autocomplete="off" spellcheck="false" class="h-7 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
</SettingsFieldRow>
<SettingsFieldRow label="Vector dimension">
  <SettingsNumberInput value={typeof dimension === "number" ? dimension : undefined} min={1} max={8192} step={1} ariaLabel="Vector dimension" onChange={(value) => set("vectorSize", value)} />
</SettingsFieldRow>
{#if provider === "ollama"}
  <SettingsFieldRow label="Ollama endpoint" description="Optional; defaults to http://127.0.0.1:11434.">
    <input aria-label="Ollama endpoint" value={text("ollamaBaseUrl")} oninput={(event) => set("ollamaBaseUrl", event.currentTarget.value || undefined)} autocomplete="off" class="h-7 w-full rounded-md border border-input bg-panel-strong px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
  </SettingsFieldRow>
{/if}
{#if !embedding}<p class="px-2.5 py-2 text-xs text-muted-foreground">Not configured. Semantic search is off; local search is unchanged.</p>{/if}
<SettingsFieldRow label="Reranker model" description="Optional OpenRouter model at search.rerankerModel (for example voyageai/rerank-3-lite). Saving authorizes sending queries, bounded Code/Knowledge text and Sessions/Tasks/Commits titles/snippets across projects in Pi and Desktop; charges may apply. One merged pass, even without embeddings; Settings stay local. Empty disables it; pure agent/native lexical search stays local. Desktop shows local results first. Uses OPENROUTER_API_KEY or shared Pi auth. Provider errors retain original results.">
  <input aria-label="Reranker model" value={typeof reranker === "string" ? reranker : ""} oninput={(event) => setReranker(event.currentTarget.value)} autocomplete="off" spellcheck="false" class="h-7 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
</SettingsFieldRow>
