import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { applyEdits, modify } from "jsonc-parser";
import { parseEmbeddingSettings, parseSemanticConfiguration, semanticConfigurationPath, semanticConfigurationText } from "./native-embedding-provider.mjs";
import { resetHistoryVectors } from "./semantic-reset.js";

const disclosure = "Saving provider configuration authorizes semantic search for all projects and sources in Pi and Desktop. Saved task titles/descriptions are embedded automatically on session startup and task changes; searches may send eligible code/document chunks, paths/headings, saved session names, commit metadata, settings metadata and queries to that provider and incur charges. Conversation bodies and attachments are not embedded. Repository indexing is bounded to 128 missing chunks per search. Local lexical search makes no embedding calls.";

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
export function registerSemanticConsentCommand(pi: ExtensionAPI, refreshTasks: () => void = () => {}): void {
  pi.registerCommand("search-semantic", {
    description: "Global semantics: status | configure <embedding JSON> | off | reset-history. Reset explicitly deletes current-project history vectors, not canonical history.",
    handler: async (args, ctx) => {
      const input = args.trim();
      const action = input.split(/\s+/, 1)[0] || "status";
      if (!["status", "configure", "off", "reset-history"].includes(action)) {
        ctx.ui.notify(`Usage: /search-semantic status | configure {"embeddingProvider":"…","embeddingModel":"…","vectorSize":…} | off | reset-history. ${disclosure}`, "warning"); return;
      }
      try {
        if (action === "reset-history") {
          if (input !== action) throw new Error("Unexpected reset arguments");
          const count = await resetHistoryVectors(ctx.cwd, AbortSignal.timeout(40_000));
          refreshTasks();
          ctx.ui.notify(`Removed ${count} derived history/settings vectors in ${ctx.cwd}. Canonical tasks, sessions, Git history, local documents and repository vectors are unchanged. Saved tasks catch up automatically; other histories rebuild on the next semantic search with the configured model and may incur charges.`, "info"); return;
        }
        if (action === "status") {
          const settings = parseEmbeddingSettings(await semanticConfigurationText());
          const identity = settings ? [...new Set(Object.values(settings.configs).map(config => `${config.provider}/${config.model}`))].join(", ") : "not configured (local-only)";
          ctx.ui.notify(`Global semantics: ${identity}. Settings: ${semanticConfigurationPath()}. ${disclosure}`, "info"); return;
        }
        let embedding: unknown;
        if (action === "configure") {
          embedding = JSON.parse(input.slice(action.length).trim());
          if (!parseEmbeddingSettings(JSON.stringify({ search: { embedding } }))) throw new Error("Invalid embedding configuration");
        }
        await saveConfiguration(embedding);
        refreshTasks();
        ctx.ui.notify(action === "configure" ? `Global semantic provider saved. ${disclosure}` : "Global semantics disabled. Cached vectors retained; local search remains available.", "info");
      } catch {
        ctx.ui.notify(action === "reset-history"
          ? "Could not reset history vectors: storage is busy, unsafe or unrecognized. No reset was committed."
          : "Could not change global semantic settings. Check provider/model/dimensions and malformed, redirected, locked or concurrently changed storage. Existing settings were not replaced.", "warning");
      }
    },
  });
}
