import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { applyEdits, modify } from "jsonc-parser";
import { parseEmbeddingSettings, parseSemanticConfiguration, semanticConfigurationPath, semanticConfigurationText } from "./native-embedding-provider.mjs";
import { resetHistoryVectors } from "./semantic-reset.js";
import { logSearchDiagnostic as writeDiagnostic } from "./search-logging.mjs";
import { suiteDiagnostics } from "../lib/suite-diagnostics.js";

const disclosure = "Saving provider configuration authorizes semantic search for all projects and sources in Pi and Desktop. Saved tasks embed on startup and changes. Session names and public user/assistant text embed after one hour of per-session inactivity with no running agent; new activity resets only that session's delay, and restart reuses persisted activity. Session queries rank existing vectors without embedding documents. Indexing/searches may send code/document chunks, paths/headings, saved session names, commit metadata, settings metadata and queries and incur charges. Tool payloads, thinking and attachments are excluded. Use /search-index sessions for immediate manual indexing or retry. Repository indexing is bounded to 128 missing chunks per search. Local lexical search makes no embedding calls.";

async function saveConfiguration(embedding: unknown | undefined): Promise<void> {
  const file = semanticConfigurationPath();
  await semanticConfigurationText(file);
  await mkdir(dirname(file), { recursive: true });
  await semanticConfigurationText(file);
  // Shared with Desktop: never steal a possibly live writer's lock.
  const lock = `${file}.search.lock`;
  await mkdir(lock);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const original = await semanticConfigurationText(file);
    parseSemanticConfiguration(original);
    const bytes = applyEdits(original, modify(original, ["search", "embedding"], embedding, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n" },
    }));
    parseSemanticConfiguration(bytes);
    if (embedding !== undefined && !parseEmbeddingSettings(bytes)) throw new Error("Invalid embedding configuration");
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (await semanticConfigurationText(file) !== original) throw new Error("Settings changed");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true });
  }
}

/** User command only: never exposed as a model-callable configuration mutation. */
export function registerSemanticConsentCommand(pi: ExtensionAPI, refreshTasks: () => void = () => {}, logSearchDiagnostic = writeDiagnostic): void {
  pi.registerCommand("search-semantic", {
    description: "Global semantics: status | configure <embedding JSON> | off | reset-history. Reset deletes current-project history vectors, not canonical history or global Settings vectors.",
    handler: async (args, ctx) => {
      const input = args.trim();
      const action = input.split(/\s+/, 1)[0] || "status";
      if (!["status", "configure", "off", "reset-history"].includes(action)) {
        void logSearchDiagnostic(ctx.cwd, { event: "search_command", message: `Usage: /search-semantic status | configure {"embeddingProvider":"…","embeddingModel":"…","vectorSize":…} | off | reset-history. ${disclosure}`, reason: "warning" }); return;
      }
      try {
        if (action === "reset-history") {
          if (input !== action) throw new Error("Unexpected reset arguments");
          const count = await resetHistoryVectors(ctx.cwd, AbortSignal.timeout(40_000));
          refreshTasks();
          void logSearchDiagnostic(ctx.cwd, { event: "search_command", message: `Removed ${count} derived history vectors in ${ctx.cwd}. Global Settings vectors, canonical tasks, sessions, Git history, local documents and repository vectors are unchanged. Saved tasks catch up automatically; use /search-index sessions to rebuild session vectors immediately. Other histories rebuild on the next semantic search with the configured model and may incur charges.`, reason: "info" }); return;
        }
        if (action === "status") {
          const settings = parseEmbeddingSettings(await semanticConfigurationText());
          const identity = settings ? [...new Set(Object.values(settings.configs).map(config => `${config.provider}/${config.model}`))].join(", ") : "not configured (local-only)";
          void logSearchDiagnostic(ctx.cwd, { event: "search_command", message: `Global semantics: ${identity}. Settings: ${semanticConfigurationPath()}. ${disclosure}`, reason: "info" }); return;
        }
        let embedding: unknown;
        if (action === "configure") {
          embedding = JSON.parse(input.slice(action.length).trim());
          if (!parseEmbeddingSettings(JSON.stringify({ search: { embedding } }))) throw new Error("Invalid embedding configuration");
        }
        await saveConfiguration(embedding);
        refreshTasks();
        void logSearchDiagnostic(ctx.cwd, { event: "search_command", message: action === "configure" ? `Global semantic provider saved. ${disclosure}` : "Global semantics disabled. Cached vectors retained; local search remains available.", reason: "info" });
      } catch {
        if (!ctx.signal?.aborted) suiteDiagnostics.report("warn", "search", "semantic-settings-failed", ctx.cwd,
          { action }, ctx);
        void logSearchDiagnostic(ctx.cwd, { event: "search_command", message: action === "reset-history"
          ? "Could not reset history vectors: storage is busy, unsafe or unrecognized. No reset was committed."
          : "Could not change global semantic settings. Check provider/model/dimensions and malformed, redirected, locked or concurrently changed storage. Existing settings were not replaced.", reason: "warning" });
      }
    },
  });
}
