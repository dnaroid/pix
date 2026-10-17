import { realpath } from "node:fs/promises";
import { settingsCatalogueDigest } from "../external/pi-tools-suite/src/project-search/source-coverage.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readSourcePolicy, writeSourcePolicy, SEARCH_SOURCES } from "../external/pi-tools-suite/src/project-search/source-policy.mjs";
import { readManualRuns, controlManualIndex } from "../external/pi-tools-suite/src/project-search/index-control.mjs";
import { runManagedIndex, type ManualSource } from "../external/pi-tools-suite/src/project-search/managed-index-run.mjs";
import { readIndexStatus } from "../external/pi-tools-suite/src/project-search/index-status.js";
import { SETTINGS_SEARCH_CATALOG } from "../desktop/src/lib/settings-search-catalog.js";
import { snapshotFreshness, type SnapshotObservations } from "../desktop/src/lib/search-index-freshness.js";

export const help = `Usage: npm run search:index -- <command> [source|all] [--project PATH] [--json]
Commands: status | check | index | continue | stop | enable | disable | migrate
Sources: code, knowledge, settings, sessions, tasks, commits
status/check/stop default to all; index/continue/enable/disable require a target.
index/continue all processes only enabled sources, sequentially. Configured provider charges may apply.
Runs stay in the foreground. Ctrl-C or a second shell's stop cancels owned work; committed batches remain.
Settings cache and enablement are global; all other sources remain project-local.
migrate settings imports compatible legacy project vectors without provider requests or deleting originals.
status/check are local/read-only and never request embeddings. Results and coverage are shared with Desktop.`;

export function parseIndexArgs(args: string[]) {
  let project = process.cwd();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (value === "--project") {
      if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error("--project requires a path");
      project = args[++i]!;
    } else if (value === "--json") { /* JSON is the stable default output. */ }
    else if (value === "--help" || value === "-h") return { action: "help", target: "all", project };
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  const [action = "status", target = "all"] = positional;
  if (positional.length > 2 || !["status", "check", "index", "continue", "stop", "enable", "disable", "migrate"].includes(action)
    || (target !== "all" && !SEARCH_SOURCES.includes(target as ManualSource))
    || (["index", "continue", "enable", "disable"].includes(action) && positional.length < 2)
    || (["enable", "disable"].includes(action) && target === "all")
    || (action === "migrate" && target !== "settings")) throw new Error(help);
  return { action, target, project };
}

export async function searchIndexMain(args: string[]): Promise<number> {
  const parsed = parseIndexArgs(args);
  if (parsed.action === "help") { console.log(help); return 0; }
  const { action, target } = parsed;
  const root = await realpath(resolve(parsed.project));
  const sources = target === "all" ? [...SEARCH_SOURCES] : [target as ManualSource];
  const output = (value: unknown) => console.log(JSON.stringify({ project: root, action, ...value as object }, null, 2));
  if (action === "enable" || action === "disable") {
    output(await writeSourcePolicy(root, target as ManualSource, action === "enable")); return 0;
  }
  if (action === "stop") {
    const stopped: Partial<Record<ManualSource, unknown>> = {};
    const batch = target === "all" ? await controlManualIndex(root, { action: "stop", source: "all" }) : undefined;
    for (const source of sources) stopped[source] = await controlManualIndex(root, { action: "stop", source });
    output({ batch, sources: stopped }); return 0;
  }
  const policy = await readSourcePolicy(root);
  const settings = SETTINGS_SEARCH_CATALOG.map(({ id, section, label, description, synonyms }) =>
    ({ id, section, label, description: description ?? "", synonyms: [...synonyms] }));
  const settingsDigest = settingsCatalogueDigest(settings);
  if (action === "status" || action === "check") {
    const runs = await readManualRuns(root);
    let observations: SnapshotObservations = {};
    if (action === "check") {
      const { probeSnapshots } = await import("../external/pi-tools-suite/src/project-search/snapshot-probe.mjs");
      observations = (await probeSnapshots(root, { operation: "snapshot-probe", sources, settingsDigest })).observations;
    }
    output({ policy, batch: runs.all, stores: await readIndexStatus(root), sources: Object.fromEntries(sources.map(source => [source, {
      enabled: policy.enabled[source], run: runs[source],
      ...(action === "check" ? { observation: observations[source], freshness: snapshotFreshness(runs[source]?.receipt, observations[source]) } : {}),
    }])) });
    return policy.error ? 1 : 0;
  }
  if (policy.error) throw new Error(policy.error);
  if (action === "migrate") {
    if (!policy.enabled.settings) throw new Error("Settings search is globally disabled");
    const { loadSemanticEmbeddingConfig } = await import("../acp/src/search/config.js");
    const config = await loadSemanticEmbeddingConfig();
    if (!config) throw new Error("No embedding identity configured; cannot verify legacy vector compatibility");
    const { SearchIndexStore } = await import("../acp/src/search/index-store.js");
    const { settingsDocuments } = await import("../acp/src/search/documents.js");
    const { withSourcePolicy } = await import("../acp/src/search/source-policy.js");
    const store = new SearchIndexStore();
    const cache = await withSourcePolicy(root, new AbortController().signal, signal =>
      store.write(root, signal, tx => tx.load(settingsDocuments(settings)), config, { source: "settings", retry: true }));
    output({ path: store.path(root), reusableVectors: cache.vectors.size, providerRequests: 0 });
    return 0;
  }
  const selected = sources.filter(source => policy.enabled[source]);
  if (target !== "all" && !selected.length) throw new Error(`${target} is disabled; use enable ${target} explicitly first`);
  const owner = new AbortController();
  const abort = () => owner.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const results: Record<string, unknown> = {};
  let code = 0;
  const runSelected = async (batchSignal: AbortSignal, check?: () => Promise<void>) => {
    for (const source of selected) {
      await check?.();
      if (batchSignal.aborted) { code = 130; break; }
      console.error(`${source}: indexing; configured provider charges may apply. Stop: npm run search:index -- stop ${source} --project ${JSON.stringify(root)}`);
      try {
        const result = await runManagedIndex(request => controlManualIndex(root, request), source, batchSignal, async signal => {
          await check?.();
          if (source === "settings") {
            const { DesktopSearchService } = await import("../acp/src/search/service.js");
            const service = new DesktopSearchService({ discover: async () => [] });
            try { return await service.index({ cwd: root, source, settings }, signal); }
            finally { await service.dispose(); }
          }
          const { runSourceIndex } = await import("../external/pi-tools-suite/src/project-search/index-runner.js");
          return { source, ...await runSourceIndex(root, source, signal) };
        }, settingsDigest);
        results[source] = result;
        if (!result.complete) code = 2;
      } catch (error) {
        results[source] = { error: error instanceof Error ? error.message : "Indexing failed" };
        code = batchSignal.aborted ? 130 : 1;
        // A cooperative remote Stop must not unexpectedly start the next source.
        break;
      }
    }
  };
  try {
    if (target === "all") {
      await runManagedIndex(request => controlManualIndex(root, request), "all", owner.signal, async (signal, check) => {
        await runSelected(signal, check);
        return { source: "all", complete: code === 0 };
      });
    } else await runSelected(owner.signal);
  } catch (error) {
    results.batch = { error: error instanceof Error ? error.message : "Indexing failed" };
    code = owner.signal.aborted || (error instanceof Error && error.name === "AbortError") ? 130 : 1;
  } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
  output({ results, skipped: sources.filter(source => !policy.enabled[source]) });
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  searchIndexMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof Error ? error.message : "Search indexing command failed"); process.exitCode = 1;
  });
}
