import { openStore } from "./native-store.mjs";
import { readSafeFile } from "./native-scan.mjs";
import { readSourceExtensions, sourceKind } from "./native-source-config.mjs";
import { digest } from "./native-embedding-provider.mjs";
import { requireSourceEnabled } from "./source-policy.mjs";

/** Reopen only for short checkpoints; no SQLite handle spans reranker transport. */
export async function verifyRerankerCandidates(root, candidates, states, signal, verifyContent) {
  const extensions = verifyContent ? await readSourceExtensions() : undefined;
  for (const source of new Set(candidates.map(hit => hit.kind))) {
    await requireSourceEnabled(root, source, signal);
    const state = states.get(source);
    if (!state) throw new Error("Native candidate snapshot unavailable");
    const store = await openStore(root, source);
    try {
      if (store.db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get()?.generation !== state.generation) throw new Error("Native candidate snapshot changed");
      if (verifyContent) {
        for (const name of new Set(candidates.filter(hit => hit.kind === source).map(hit => hit.path))) {
          const file = await readSafeFile(root, name);
          if (sourceKind(name, extensions) !== source || digest(`${source}:${file.hash}`) !== state.hashes.get(name)) throw new Error("Native candidate content changed");
        }
      }
      signal.throwIfAborted();
    } finally { store.close(); }
  }
}
